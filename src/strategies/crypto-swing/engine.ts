/**
 * Crypto Swing Trading — Core Engine
 *
 * Self-contained engine with its own eval loop.
 * Fetches 4h OHLCV candles, computes TA indicators, generates signals,
 * manages positions with ATR-based stops and trailing.
 */

import { logger } from '../../utils/logger.js';
import { ema, rsi, macd, bollinger, atr } from '../../trading/indicators.js';
import { SwingStore, type SwingDb } from './store.js';
import { PaperExecutor } from './paper-executor.js';
import { LiveExecutor } from './live-executor.js';
import type { CryptoFeed, OHLCV } from '../../feeds/crypto/index.js';
import type {
  SwingEngine as ISwingEngine,
  SwingEngineConfig,
  SwingEngineStats,
  SwingPosition,
  SwingTrade,
  SwingEquitySnapshot,
  SwingSignal,
  SwingSymbol,
  SwingSide,
  SwingExitReason,
} from './types.js';
import { DEFAULT_SWING_CONFIG } from './types.js';

interface IndicatorSet {
  emaFast: number[];
  emaSlow: number[];
  rsiValues: number[];
  macdHist: number[];
  bbUpper: number[];
  bbLower: number[];
  atrValues: number[];
  closes: number[];
}

export function createSwingEngine(
  feed: CryptoFeed,
  db: SwingDb,
  configOverrides?: Partial<SwingEngineConfig>,
): ISwingEngine {
  const store = new SwingStore(db);
  store.init();

  // Load persisted config, merge with defaults and overrides
  let config: SwingEngineConfig = {
    ...DEFAULT_SWING_CONFIG,
    ...(store.loadConfig() ?? {}),
    ...(configOverrides ?? {}),
  };

  const paperExec = new PaperExecutor(config);
  const liveExec = new LiveExecutor(config);

  let running = false;
  let evalTimer: ReturnType<typeof setInterval> | null = null;
  const priceUnsubs: Array<() => void> = [];

  // In-memory position cache, synced with store
  let positions: SwingPosition[] = store.getOpenPositions();

  // Restore paper balance from equity curve or initial capital
  const lastEquity = store.getEquityCurve(1);
  if (lastEquity.length > 0 && config.mode === 'paper') {
    paperExec.setBalance(lastEquity[0].equity - positions.reduce((s, p) => s + p.sizeUsd, 0));
  }

  // ── Indicator Computation ──

  function computeIndicators(candles: OHLCV[]): IndicatorSet | null {
    if (candles.length < config.emaSlow + 10) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const emaFast = ema(closes, config.emaFast);
    const emaSlow = ema(closes, config.emaSlow);
    const rsiValues = rsi(closes, config.rsiPeriod);
    const macdResult = macd(closes, 12, 26, 9);
    const bb = bollinger(closes, 20, 2);
    const atrValues = atr(highs, lows, closes, 14);

    if (emaSlow.length === 0 || rsiValues.length === 0 || macdResult.histogram.length === 0 || bb.upper.length === 0 || atrValues.length === 0) {
      return null;
    }

    return {
      emaFast,
      emaSlow,
      rsiValues,
      macdHist: macdResult.histogram,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      atrValues,
      closes,
    };
  }

  // ── Signal Generation ──

  function generateSignal(symbol: SwingSymbol, ind: IndicatorSet): SwingSignal | null {
    const len = ind.emaSlow.length;
    // Align all arrays to the shortest (emaSlow)
    const fastOffset = ind.emaFast.length - len;
    const rsiOffset = ind.rsiValues.length - len;
    const macdOffset = ind.macdHist.length - len;
    const bbOffset = ind.bbUpper.length - len;
    const atrOffset = ind.atrValues.length - len;

    // Current values (last element)
    const i = len - 1;
    const emaF = ind.emaFast[i + fastOffset];
    const emaS = ind.emaSlow[i];
    const curRsi = ind.rsiValues[i + rsiOffset] ?? 50;
    const curMacd = ind.macdHist[i + macdOffset] ?? 0;
    const curBBUpper = ind.bbUpper[i + bbOffset] ?? Infinity;
    const curBBLower = ind.bbLower[i + bbOffset] ?? 0;
    const curClose = ind.closes[ind.closes.length - 1];

    // Check for crossover in last 3 candles
    let bullishCross = false;
    let bearishCross = false;
    for (let j = Math.max(0, len - 3); j < len; j++) {
      const prevJ = j - 1;
      if (prevJ < 0) continue;
      const fCur = ind.emaFast[j + fastOffset];
      const fPrev = ind.emaFast[prevJ + fastOffset];
      const sCur = ind.emaSlow[j];
      const sPrev = ind.emaSlow[prevJ];
      if (fPrev !== undefined && sPrev !== undefined) {
        if (fPrev <= sPrev && fCur > sCur) bullishCross = true;
        if (fPrev >= sPrev && fCur < sCur) bearishCross = true;
      }
    }

    // Long entry conditions
    if (
      emaF > emaS &&
      bullishCross &&
      curRsi >= config.rsiOversold + 5 && curRsi <= config.rsiOverbought &&
      curMacd > 0 &&
      curClose < curBBUpper
    ) {
      return {
        symbol,
        side: 'long',
        strength: Math.min(1, Math.abs(curMacd) * 10),
        reason: `EMA${config.emaFast}>${config.emaSlow} cross, RSI=${curRsi.toFixed(1)}, MACD+`,
        timestamp: new Date(),
      };
    }

    // Short entry conditions
    if (
      emaF < emaS &&
      bearishCross &&
      curRsi >= config.rsiOversold && curRsi <= config.rsiOverbought - 5 &&
      curMacd < 0 &&
      curClose > curBBLower
    ) {
      return {
        symbol,
        side: 'short',
        strength: Math.min(1, Math.abs(curMacd) * 10),
        reason: `EMA${config.emaFast}<${config.emaSlow} cross, RSI=${curRsi.toFixed(1)}, MACD-`,
        timestamp: new Date(),
      };
    }

    return null;
  }

  // ── Position Sizing ──

  function getPositionSize(): number {
    const balance = config.mode === 'paper' ? paperExec.getBalance() : config.initialCapital;
    return Math.min(config.maxPositionSizeUsd, balance * config.maxPositionPct);
  }

  // ── Exit Logic ──

  function checkExit(pos: SwingPosition, currentPrice: number, signal: SwingSignal | null, currentAtr: number): SwingExitReason | null {
    // Stop loss
    if (pos.side === 'long' && currentPrice <= pos.stopLoss) return 'stop_loss';
    if (pos.side === 'short' && currentPrice >= pos.stopLoss) return 'stop_loss';

    // Take profit
    if (pos.side === 'long' && currentPrice >= pos.takeProfit) return 'take_profit';
    if (pos.side === 'short' && currentPrice <= pos.takeProfit) return 'take_profit';

    // Trailing stop
    if (config.trailingStopEnabled && pos.trailingStop !== null) {
      if (pos.side === 'long' && currentPrice <= pos.trailingStop) return 'trailing_stop';
      if (pos.side === 'short' && currentPrice >= pos.trailingStop) return 'trailing_stop';
    }

    // Signal reversal
    if (signal && signal.symbol === pos.symbol && signal.side !== pos.side) return 'signal_reversal';

    return null;
  }

  function updateTrailingStop(pos: SwingPosition, currentPrice: number, currentAtr: number): void {
    if (!config.trailingStopEnabled) return;

    if (pos.side === 'long') {
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        const newTrailing = currentPrice - currentAtr * 2.0;
        if (pos.trailingStop === null || newTrailing > pos.trailingStop) {
          pos.trailingStop = newTrailing;
          store.updatePosition(pos.id, {
            highWaterMark: pos.highWaterMark,
            trailingStop: pos.trailingStop,
          });
        }
      }
    } else {
      if (currentPrice < pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
        const newTrailing = currentPrice + currentAtr * 2.0;
        if (pos.trailingStop === null || newTrailing < pos.trailingStop) {
          pos.trailingStop = newTrailing;
          store.updatePosition(pos.id, {
            highWaterMark: pos.highWaterMark,
            trailingStop: pos.trailingStop,
          });
        }
      }
    }
  }

  // ── Trade Execution ──

  async function openTrade(signal: SwingSignal, currentPrice: number, currentAtr: number): Promise<void> {
    const sizeUsd = getPositionSize();
    if (sizeUsd < 10) {
      logger.debug({ symbol: signal.symbol, sizeUsd }, '[Swing] Position size too small, skipping');
      return;
    }

    const slDistance = currentAtr * config.stopLossAtrMultiplier;
    const tpDistance = slDistance * config.takeProfitRatio;

    let stopLoss: number;
    let takeProfit: number;

    if (signal.side === 'long') {
      stopLoss = currentPrice - slDistance;
      takeProfit = currentPrice + tpDistance;
    } else {
      stopLoss = currentPrice + slDistance;
      takeProfit = currentPrice - tpDistance;
    }

    let position: SwingPosition | null;

    if (config.mode === 'paper') {
      position = paperExec.openPosition(signal.symbol, signal.side, sizeUsd, currentPrice, stopLoss, takeProfit);
    } else {
      position = await liveExec.openPosition(signal.symbol, signal.side, sizeUsd, currentPrice, stopLoss, takeProfit);
    }

    if (position) {
      store.savePosition(position);
      positions.push(position);

      logger.info(
        { symbol: signal.symbol, side: signal.side, entry: position.entryPrice, sl: stopLoss, tp: takeProfit, reason: signal.reason },
        '[Swing] Opened position',
      );
    }
  }

  async function closeTrade(pos: SwingPosition, currentPrice: number, reason: SwingExitReason): Promise<void> {
    let trade: SwingTrade | null;

    if (config.mode === 'paper') {
      trade = paperExec.closePosition(pos, currentPrice, reason);
    } else {
      trade = await liveExec.closePosition(pos, currentPrice, reason);
    }

    if (trade) {
      store.saveTrade(trade);
      store.removePosition(pos.id);
      positions = positions.filter((p) => p.id !== pos.id);

      logger.info(
        { symbol: pos.symbol, pnl: trade.pnl.toFixed(2), reason },
        '[Swing] Closed position',
      );
    }
  }

  // ── Eval Cycle ──

  async function evaluate(): Promise<void> {
    try {
      for (const symbol of config.symbols) {
        const candles = await feed.getOHLCV(symbol, config.ohlcvInterval, 100);
        if (candles.length < config.emaSlow + 10) {
          logger.debug({ symbol, candles: candles.length }, '[Swing] Not enough candles');
          continue;
        }

        const ind = computeIndicators(candles);
        if (!ind) continue;

        const currentPrice = candles[candles.length - 1].close;
        const currentAtr = ind.atrValues[ind.atrValues.length - 1] ?? 0;
        const signal = generateSignal(symbol, ind);

        // Check exits on open positions for this symbol
        const pos = positions.find((p) => p.symbol === symbol);
        if (pos) {
          // Update current price
          pos.currentPrice = currentPrice;
          store.updatePosition(pos.id, { currentPrice });

          // Update trailing stop
          updateTrailingStop(pos, currentPrice, currentAtr);

          // Check exit
          const exitReason = checkExit(pos, currentPrice, signal, currentAtr);
          if (exitReason) {
            await closeTrade(pos, currentPrice, exitReason);
            // If signal reversal, let new signal be handled in the entry check below
            if (exitReason !== 'signal_reversal') continue;
          } else {
            continue; // Position still open, skip entry check
          }
        }

        // Entry check
        if (signal && positions.length < config.maxOpenPositions) {
          const existingPos = positions.find((p) => p.symbol === symbol);
          if (!existingPos) {
            await openTrade(signal, currentPrice, currentAtr);
          }
        }
      }

      // Save equity snapshot
      const openValue = positions.reduce((sum, p) => {
        const pnl = p.side === 'long'
          ? (p.currentPrice - p.entryPrice) * p.quantity
          : (p.entryPrice - p.currentPrice) * p.quantity;
        return sum + p.sizeUsd + pnl;
      }, 0);

      const cashBalance = config.mode === 'paper' ? paperExec.getBalance() : config.initialCapital;
      const equity = cashBalance + openValue;

      // Day PnL — compare to start of day equity
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTrades = store.getTrades(100).filter((t) => t.exitTime >= today);
      const dayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);

      store.saveEquitySnapshot({
        timestamp: new Date(),
        equity,
        openPositions: positions.length,
        dayPnl,
      });
    } catch (err) {
      logger.error({ err }, '[Swing] Eval cycle error');
    }
  }

  // ── Real-time Price Subscriptions ──

  function subscribePrices(): void {
    for (const symbol of config.symbols) {
      const unsub = feed.subscribeSymbol(symbol, (update) => {
        const pos = positions.find((p) => p.symbol === symbol);
        if (!pos) return;

        pos.currentPrice = update.price;

        // Quick trailing stop / SL / TP check between eval cycles
        if (pos.side === 'long') {
          if (update.price <= pos.stopLoss || (pos.trailingStop !== null && update.price <= pos.trailingStop)) {
            closeTrade(pos, update.price, pos.trailingStop !== null && update.price <= pos.trailingStop ? 'trailing_stop' : 'stop_loss')
              .catch((err) => logger.error({ err, symbol }, '[Swing] RT exit error'));
          } else if (update.price >= pos.takeProfit) {
            closeTrade(pos, update.price, 'take_profit')
              .catch((err) => logger.error({ err, symbol }, '[Swing] RT exit error'));
          }
        } else {
          if (update.price >= pos.stopLoss || (pos.trailingStop !== null && update.price >= pos.trailingStop)) {
            closeTrade(pos, update.price, pos.trailingStop !== null && update.price >= pos.trailingStop ? 'trailing_stop' : 'stop_loss')
              .catch((err) => logger.error({ err, symbol }, '[Swing] RT exit error'));
          } else if (update.price <= pos.takeProfit) {
            closeTrade(pos, update.price, 'take_profit')
              .catch((err) => logger.error({ err, symbol }, '[Swing] RT exit error'));
          }
        }
      });
      priceUnsubs.push(unsub);
    }
  }

  // ── Public Interface ──

  return {
    async start() {
      if (running) return;
      running = true;

      logger.info(
        { mode: config.mode, symbols: config.symbols, interval: config.ohlcvInterval },
        '[Swing] Engine starting',
      );

      // Initial eval
      await evaluate();

      // Schedule periodic evals
      evalTimer = setInterval(() => {
        evaluate().catch((err) => logger.error({ err }, '[Swing] Eval error'));
      }, config.evalIntervalMs);

      // Subscribe to real-time prices for exit checks
      subscribePrices();

      logger.info('[Swing] Engine started');
    },

    stop() {
      if (!running) return;
      running = false;

      if (evalTimer) {
        clearInterval(evalTimer);
        evalTimer = null;
      }

      for (const unsub of priceUnsubs) unsub();
      priceUnsubs.length = 0;

      store.saveConfig(config);
      logger.info('[Swing] Engine stopped');
    },

    isRunning() {
      return running;
    },

    getConfig() {
      return { ...config };
    },

    updateConfig(partial) {
      config = { ...config, ...partial };
      paperExec.updateConfig(config);
      liveExec.updateConfig(config);
      store.saveConfig(config);
      logger.info({ partial }, '[Swing] Config updated');
    },

    getPositions() {
      return [...positions];
    },

    getTrades(limit = 50) {
      return store.getTrades(limit);
    },

    getStats() {
      const cashBalance = config.mode === 'paper' ? paperExec.getBalance() : config.initialCapital;
      const openValue = positions.reduce((sum, p) => sum + p.sizeUsd + p.unrealizedPnl, 0);
      return store.getStats(cashBalance + openValue, cashBalance);
    },

    getEquityCurve(limit = 200) {
      return store.getEquityCurve(limit);
    },

    async closePosition(symbol, reason = 'manual') {
      const pos = positions.find((p) => p.symbol === symbol);
      if (!pos) return false;

      const price = feed.getPrice(symbol) ?? pos.currentPrice;
      await closeTrade(pos, price, reason);
      return true;
    },

    getMode() {
      return config.mode;
    },
  };
}
