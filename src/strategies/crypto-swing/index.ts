/**
 * Crypto Swing Trading — BotManager Adapter
 *
 * Wraps the self-contained SwingEngine as a BotManager Strategy.
 * Same pattern as createCryptoHftAdapter.
 */

import type { CryptoFeed } from '../../feeds/crypto/index.js';
import type { Strategy, Signal, StrategyConfig, StrategyContext } from '../../trading/bots/index.js';
import type { SwingDb } from './store.js';
import type { SwingEngine, SwingEngineConfig } from './types.js';

// Re-export for gateway convenience
export type { SwingEngine } from './types.js';

export interface CryptoSwingAdapterOpts {
  feed: CryptoFeed;
  db: SwingDb;
  config?: Partial<SwingEngineConfig>;
}

export function createCryptoSwingAdapter(opts: CryptoSwingAdapterOpts): Strategy & { getEngine(): SwingEngine | null } {
  let engine: SwingEngine | null = null;

  const strategyConfig: StrategyConfig = {
    id: 'crypto-swing',
    name: 'Crypto Swing Trading',
    description: 'Automated crypto swing trading with EMA/RSI/MACD/Bollinger signals',
    platforms: ['polymarket' as any], // Required by Strategy interface; engine handles its own markets
    intervalMs: 60_000, // BotManager polls every 60s; engine has its own eval loop
    dryRun: opts.config?.mode !== 'live',
    params: opts.config,
  };

  return {
    config: strategyConfig,

    async init(_ctx?: StrategyContext) {
      const { createSwingEngine } = await import('./engine.js');
      engine = createSwingEngine(opts.feed, opts.db, opts.config);
      await engine.start();
    },

    async evaluate(_ctx: StrategyContext): Promise<Signal[]> {
      if (!engine) return [];

      const positions = engine.getPositions();
      return positions.map((pos) => ({
        type: 'hold' as const,
        platform: 'polymarket' as const, // Strategy interface requires Platform type
        marketId: `swing-${pos.symbol}`,
        outcome: pos.side,
        reason: `${pos.side} ${pos.symbol} @ ${pos.entryPrice.toFixed(2)} | PnL: ${pos.unrealizedPnl.toFixed(2)}`,
        meta: {
          entryPrice: pos.entryPrice,
          currentPrice: pos.currentPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          unrealizedPnl: pos.unrealizedPnl,
          mode: pos.mode,
        },
      }));
    },

    async cleanup() {
      if (engine) {
        engine.stop();
        engine = null;
      }
    },

    /** Direct access to the engine for handlers/routes */
    getEngine(): SwingEngine | null {
      return engine;
    },
  };
}
