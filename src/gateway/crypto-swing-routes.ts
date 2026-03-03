/**
 * Crypto Swing Trading — HTTP REST Routes
 *
 * Follows createCopyTradingRouter pattern.
 */

import { Router } from 'express';
import type { SwingEngine, SwingSymbol } from '../strategies/crypto-swing/types.js';

export interface CryptoSwingRouterDeps {
  engine: SwingEngine;
}

export function createCryptoSwingRouter(deps: CryptoSwingRouterDeps): Router {
  const router = Router();
  const { engine } = deps;

  router.get('/status', (_req, res) => {
    const stats = engine.getStats();
    res.json({
      ok: true,
      data: {
        running: engine.isRunning(),
        mode: engine.getMode(),
        openPositions: engine.getPositions().length,
        currentEquity: stats.currentEquity,
        paperBalance: stats.paperBalance,
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        symbols: engine.getConfig().symbols,
      },
    });
  });

  router.get('/positions', (_req, res) => {
    const positions = engine.getPositions();
    res.json({
      ok: true,
      data: positions.map((p) => ({
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
      })),
    });
  });

  router.get('/trades', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const trades = engine.getTrades(limit);
    res.json({
      ok: true,
      data: trades.map((t) => ({
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
    });
  });

  router.get('/stats', (_req, res) => {
    res.json({ ok: true, data: engine.getStats() });
  });

  router.get('/equity', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 200;
    const curve = engine.getEquityCurve(limit);
    res.json({
      ok: true,
      data: curve.map((s) => ({
        timestamp: s.timestamp.toISOString(),
        equity: s.equity,
        openPositions: s.openPositions,
        dayPnl: s.dayPnl,
      })),
    });
  });

  router.post('/close/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase() as SwingSymbol;
    try {
      const closed = await engine.closePosition(symbol);
      res.json({ ok: true, data: { closed, symbol } });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.patch('/config', (req, res) => {
    const updates = req.body;
    if (updates && Object.keys(updates).length > 0) {
      engine.updateConfig(updates);
    }
    res.json({ ok: true, data: engine.getConfig() });
  });

  return router;
}
