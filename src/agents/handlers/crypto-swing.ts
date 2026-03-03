/**
 * Crypto Swing Trading — Chat Handlers
 *
 * Follows setBittensorService / bittensorHandlers pattern.
 */

import type { HandlersMap, ToolInput } from './types.js';
import { errorResult, safeHandler } from './types.js';
import type { SwingEngine, SwingSymbol, SwingEngineConfig } from '../../strategies/crypto-swing/types.js';

let engine: SwingEngine | null = null;

export function setSwingEngine(eng: SwingEngine | null): void {
  engine = eng;
}

export const cryptoSwingHandlers: HandlersMap = {
  crypto_swing_status: async (_input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      const stats = engine!.getStats();
      const positions = engine!.getPositions();
      return {
        running: engine!.isRunning(),
        mode: engine!.getMode(),
        openPositions: positions.length,
        todayPnl: stats.totalPnl,
        currentEquity: stats.currentEquity,
        paperBalance: stats.paperBalance,
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        symbols: engine!.getConfig().symbols,
      };
    }, 'Swing Status');
  },

  crypto_swing_start: async (input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      if (engine!.isRunning()) return { status: 'already_running' };
      const mode = input.mode as string | undefined;
      if (mode === 'paper' || mode === 'live') {
        engine!.updateConfig({ mode });
      }
      await engine!.start();
      return { status: 'started', mode: engine!.getMode() };
    }, 'Swing Start');
  },

  crypto_swing_stop: async (_input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      if (!engine!.isRunning()) return { status: 'already_stopped' };
      engine!.stop();
      return { status: 'stopped' };
    }, 'Swing Stop');
  },

  crypto_swing_positions: async (_input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      const positions = engine!.getPositions();
      return {
        count: positions.length,
        positions: positions.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          sizeUsd: p.sizeUsd,
          stopLoss: p.stopLoss,
          takeProfit: p.takeProfit,
          trailingStop: p.trailingStop,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPct: p.unrealizedPnlPct,
          venue: p.venue,
          mode: p.mode,
          entryTime: p.entryTime.toISOString(),
          holdingTime: `${((Date.now() - p.entryTime.getTime()) / 3600000).toFixed(1)}h`,
        })),
      };
    }, 'Swing Positions');
  },

  crypto_swing_trades: async (input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      const limit = (input.limit as number) || 20;
      const trades = engine!.getTrades(limit);
      return {
        count: trades.length,
        trades: trades.map((t) => ({
          symbol: t.symbol,
          side: t.side,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          fees: t.fees,
          exitReason: t.exitReason,
          venue: t.venue,
          mode: t.mode,
          entryTime: t.entryTime.toISOString(),
          exitTime: t.exitTime.toISOString(),
        })),
      };
    }, 'Swing Trades');
  },

  crypto_swing_stats: async (_input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      return engine!.getStats();
    }, 'Swing Stats');
  },

  crypto_swing_close: async (input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      const symbol = (input.symbol as string)?.toUpperCase() as SwingSymbol;
      if (!symbol) return { error: 'Symbol required (ETH, SOL, PEPE)' };
      const closed = await engine!.closePosition(symbol);
      return { closed, symbol };
    }, 'Swing Close');
  },

  crypto_swing_config: async (input: ToolInput) => {
    if (!engine) return errorResult('Crypto swing trading is not enabled.');
    return safeHandler(async () => {
      const updates = input.updates as Partial<SwingEngineConfig> | undefined;
      if (updates && Object.keys(updates).length > 0) {
        engine!.updateConfig(updates);
        return { status: 'updated', config: engine!.getConfig() };
      }
      return engine!.getConfig();
    }, 'Swing Config');
  },
};
