/**
 * Crypto Swing Trading — Live Executor
 *
 * Routes orders to real exchanges based on available credentials.
 * Priority: Binance perps → Hyperliquid → (DEX fallback logged only)
 */

import { logger } from '../../utils/logger.js';
import type {
  SwingPosition,
  SwingTrade,
  SwingSymbol,
  SwingSide,
  SwingExitReason,
  SwingExecVenue,
  SwingEngineConfig,
} from './types.js';

const BINANCE_SYMBOL_MAP: Record<SwingSymbol, string> = {
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  PEPE: 'PEPEUSDT',
};

const HYPERLIQUID_COIN_MAP: Record<SwingSymbol, string> = {
  ETH: 'ETH',
  SOL: 'SOL',
  PEPE: 'PEPE',
};

export class LiveExecutor {
  private config: SwingEngineConfig;

  constructor(config: SwingEngineConfig) {
    this.config = config;
  }

  private getVenue(symbol: SwingSymbol): SwingExecVenue {
    if (this.config.binance?.apiKey) return 'binance';
    if (this.config.hyperliquid?.walletAddress) return 'hyperliquid';
    logger.warn({ symbol }, '[LiveExec] No exchange credentials configured, falling back to paper');
    return 'paper';
  }

  async openPosition(
    symbol: SwingSymbol,
    side: SwingSide,
    sizeUsd: number,
    currentPrice: number,
    stopLoss: number,
    takeProfit: number,
  ): Promise<SwingPosition | null> {
    const venue = this.getVenue(symbol);

    if (venue === 'paper') return null;

    try {
      let fillPrice = currentPrice;

      if (venue === 'binance') {
        const { openLong, openShort } = await import('../../exchanges/binance-futures/index.js');
        const binanceConfig = {
          apiKey: this.config.binance!.apiKey,
          apiSecret: this.config.binance!.apiSecret,
        };
        const binanceSymbol = BINANCE_SYMBOL_MAP[symbol];
        const quantity = sizeUsd / currentPrice;

        const result = side === 'long'
          ? await openLong(binanceConfig, binanceSymbol, quantity)
          : await openShort(binanceConfig, binanceSymbol, quantity);

        fillPrice = result.avgPrice || currentPrice;

        logger.info(
          { symbol, side, venue, orderId: result.orderId, fillPrice },
          '[LiveExec] Binance order filled',
        );
      } else if (venue === 'hyperliquid') {
        const { placePerpOrder } = await import('../../exchanges/hyperliquid/index.js');
        const hlConfig = {
          walletAddress: this.config.hyperliquid!.walletAddress,
          privateKey: this.config.hyperliquid!.privateKey,
        };
        const coin = HYPERLIQUID_COIN_MAP[symbol];
        const size = sizeUsd / currentPrice;

        const result = await placePerpOrder(hlConfig, {
          coin,
          side: side === 'long' ? 'BUY' : 'SELL',
          size,
          type: 'MARKET',
        });

        if (!result.success) {
          logger.error({ symbol, error: result.error }, '[LiveExec] Hyperliquid order failed');
          return null;
        }

        logger.info(
          { symbol, side, venue, orderId: result.orderId },
          '[LiveExec] Hyperliquid order filled',
        );
      }

      const fees = sizeUsd * (this.config.feeBps / 10000);
      const netSize = sizeUsd - fees;
      const quantity = netSize / fillPrice;
      const id = `live_${symbol}_${Date.now()}`;

      return {
        id,
        symbol,
        side,
        entryPrice: fillPrice,
        currentPrice: fillPrice,
        sizeUsd: netSize,
        quantity,
        stopLoss,
        takeProfit,
        trailingStop: this.config.trailingStopEnabled ? stopLoss : null,
        highWaterMark: fillPrice,
        entryTime: new Date(),
        venue,
        mode: 'live',
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
      };
    } catch (err) {
      logger.error({ err, symbol, side, venue }, '[LiveExec] Failed to open position');
      return null;
    }
  }

  async closePosition(
    position: SwingPosition,
    currentPrice: number,
    reason: SwingExitReason,
  ): Promise<SwingTrade | null> {
    try {
      let fillPrice = currentPrice;

      if (position.venue === 'binance') {
        const { closePosition: binanceClose } = await import('../../exchanges/binance-futures/index.js');
        const binanceConfig = {
          apiKey: this.config.binance!.apiKey,
          apiSecret: this.config.binance!.apiSecret,
        };
        const binanceSymbol = BINANCE_SYMBOL_MAP[position.symbol];
        const result = await binanceClose(binanceConfig, binanceSymbol);
        if (result) {
          fillPrice = result.avgPrice || currentPrice;
        }
      } else if (position.venue === 'hyperliquid') {
        const { placePerpOrder } = await import('../../exchanges/hyperliquid/index.js');
        const hlConfig = {
          walletAddress: this.config.hyperliquid!.walletAddress,
          privateKey: this.config.hyperliquid!.privateKey,
        };
        const coin = HYPERLIQUID_COIN_MAP[position.symbol];
        await placePerpOrder(hlConfig, {
          coin,
          side: position.side === 'long' ? 'SELL' : 'BUY',
          size: position.quantity,
          type: 'MARKET',
          reduceOnly: true,
        });
      }

      const fees = position.quantity * fillPrice * (this.config.feeBps / 10000);
      const rawPnl = position.side === 'long'
        ? (fillPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - fillPrice) * position.quantity;
      const pnl = rawPnl - fees;

      logger.info(
        { symbol: position.symbol, side: position.side, fillPrice, pnl, reason },
        '[LiveExec] Closed position',
      );

      return {
        id: `trade_${position.symbol}_${Date.now()}`,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: fillPrice,
        sizeUsd: position.sizeUsd,
        quantity: position.quantity,
        pnl,
        pnlPct: position.sizeUsd > 0 ? (pnl / position.sizeUsd) * 100 : 0,
        fees,
        entryTime: position.entryTime,
        exitTime: new Date(),
        exitReason: reason,
        venue: position.venue,
        mode: 'live',
      };
    } catch (err) {
      logger.error({ err, symbol: position.symbol, reason }, '[LiveExec] Failed to close position');
      return null;
    }
  }

  updateConfig(config: SwingEngineConfig): void {
    this.config = config;
  }
}
