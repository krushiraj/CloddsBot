/**
 * Crypto Swing Trading — SQLite Persistence
 *
 * Self-creating tables following ledger/storage.ts pattern.
 */

import type {
  SwingPosition,
  SwingTrade,
  SwingEquitySnapshot,
  SwingEngineConfig,
  SwingEngineStats,
  SwingSymbol,
  SwingSide,
  SwingExitReason,
  SwingExecVenue,
  SwingMode,
} from './types.js';

export interface SwingDb {
  run(sql: string, params?: unknown[]): void;
  query<T>(sql: string, params?: unknown[]): T[];
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS swing_positions (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    quantity REAL NOT NULL,
    stop_loss REAL NOT NULL,
    take_profit REAL NOT NULL,
    trailing_stop REAL,
    high_water_mark REAL NOT NULL,
    entry_time TEXT NOT NULL,
    venue TEXT NOT NULL,
    mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS swing_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    quantity REAL NOT NULL,
    pnl REAL NOT NULL,
    pnl_pct REAL NOT NULL,
    fees REAL NOT NULL,
    entry_time TEXT NOT NULL,
    exit_time TEXT NOT NULL,
    exit_reason TEXT NOT NULL,
    venue TEXT NOT NULL,
    mode TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_swing_trades_time ON swing_trades(exit_time DESC);
  CREATE INDEX IF NOT EXISTS idx_swing_trades_symbol ON swing_trades(symbol);

  CREATE TABLE IF NOT EXISTS swing_equity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    equity REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    day_pnl REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_swing_equity_time ON swing_equity(timestamp DESC);

  CREATE TABLE IF NOT EXISTS swing_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class SwingStore {
  constructor(private db: SwingDb) {}

  init(): void {
    const statements = SCHEMA.split(';').filter((s) => s.trim());
    for (const stmt of statements) {
      this.db.run(stmt);
    }
  }

  // ── Positions ──

  savePosition(pos: SwingPosition): void {
    this.db.run(
      `INSERT OR REPLACE INTO swing_positions
       (id, symbol, side, entry_price, current_price, size_usd, quantity,
        stop_loss, take_profit, trailing_stop, high_water_mark, entry_time, venue, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pos.id, pos.symbol, pos.side, pos.entryPrice, pos.currentPrice,
        pos.sizeUsd, pos.quantity, pos.stopLoss, pos.takeProfit,
        pos.trailingStop, pos.highWaterMark, pos.entryTime.toISOString(),
        pos.venue, pos.mode,
      ],
    );
  }

  updatePosition(id: string, updates: Partial<Pick<SwingPosition, 'currentPrice' | 'trailingStop' | 'highWaterMark' | 'stopLoss'>>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.currentPrice !== undefined) { sets.push('current_price = ?'); params.push(updates.currentPrice); }
    if (updates.trailingStop !== undefined) { sets.push('trailing_stop = ?'); params.push(updates.trailingStop); }
    if (updates.highWaterMark !== undefined) { sets.push('high_water_mark = ?'); params.push(updates.highWaterMark); }
    if (updates.stopLoss !== undefined) { sets.push('stop_loss = ?'); params.push(updates.stopLoss); }

    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE swing_positions SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  removePosition(id: string): void {
    this.db.run('DELETE FROM swing_positions WHERE id = ?', [id]);
  }

  getOpenPositions(): SwingPosition[] {
    const rows = this.db.query<{
      id: string; symbol: string; side: string; entry_price: number;
      current_price: number; size_usd: number; quantity: number;
      stop_loss: number; take_profit: number; trailing_stop: number | null;
      high_water_mark: number; entry_time: string; venue: string; mode: string;
    }>('SELECT * FROM swing_positions');

    return rows.map((r) => this.rowToPosition(r));
  }

  getPositionBySymbol(symbol: SwingSymbol): SwingPosition | undefined {
    const row = this.db.query<{
      id: string; symbol: string; side: string; entry_price: number;
      current_price: number; size_usd: number; quantity: number;
      stop_loss: number; take_profit: number; trailing_stop: number | null;
      high_water_mark: number; entry_time: string; venue: string; mode: string;
    }>('SELECT * FROM swing_positions WHERE symbol = ? LIMIT 1', [symbol])[0];

    return row ? this.rowToPosition(row) : undefined;
  }

  private rowToPosition(r: {
    id: string; symbol: string; side: string; entry_price: number;
    current_price: number; size_usd: number; quantity: number;
    stop_loss: number; take_profit: number; trailing_stop: number | null;
    high_water_mark: number; entry_time: string; venue: string; mode: string;
  }): SwingPosition {
    const side = r.side as SwingSide;
    const pnlRaw = side === 'long'
      ? (r.current_price - r.entry_price) * r.quantity
      : (r.entry_price - r.current_price) * r.quantity;
    return {
      id: r.id,
      symbol: r.symbol as SwingSymbol,
      side,
      entryPrice: r.entry_price,
      currentPrice: r.current_price,
      sizeUsd: r.size_usd,
      quantity: r.quantity,
      stopLoss: r.stop_loss,
      takeProfit: r.take_profit,
      trailingStop: r.trailing_stop,
      highWaterMark: r.high_water_mark,
      entryTime: new Date(r.entry_time),
      venue: r.venue as SwingExecVenue,
      mode: r.mode as SwingMode,
      unrealizedPnl: pnlRaw,
      unrealizedPnlPct: r.size_usd > 0 ? (pnlRaw / r.size_usd) * 100 : 0,
    };
  }

  // ── Trades ──

  saveTrade(trade: SwingTrade): void {
    this.db.run(
      `INSERT INTO swing_trades
       (id, symbol, side, entry_price, exit_price, size_usd, quantity,
        pnl, pnl_pct, fees, entry_time, exit_time, exit_reason, venue, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.id, trade.symbol, trade.side, trade.entryPrice, trade.exitPrice,
        trade.sizeUsd, trade.quantity, trade.pnl, trade.pnlPct, trade.fees,
        trade.entryTime.toISOString(), trade.exitTime.toISOString(),
        trade.exitReason, trade.venue, trade.mode,
      ],
    );
  }

  getTrades(limit: number = 50): SwingTrade[] {
    return this.db.query<{
      id: string; symbol: string; side: string; entry_price: number;
      exit_price: number; size_usd: number; quantity: number;
      pnl: number; pnl_pct: number; fees: number;
      entry_time: string; exit_time: string; exit_reason: string;
      venue: string; mode: string;
    }>('SELECT * FROM swing_trades ORDER BY exit_time DESC LIMIT ?', [limit])
      .map((r) => ({
        id: r.id,
        symbol: r.symbol as SwingSymbol,
        side: r.side as SwingSide,
        entryPrice: r.entry_price,
        exitPrice: r.exit_price,
        sizeUsd: r.size_usd,
        quantity: r.quantity,
        pnl: r.pnl,
        pnlPct: r.pnl_pct,
        fees: r.fees,
        entryTime: new Date(r.entry_time),
        exitTime: new Date(r.exit_time),
        exitReason: r.exit_reason as SwingExitReason,
        venue: r.venue as SwingExecVenue,
        mode: r.mode as SwingMode,
      }));
  }

  // ── Equity ──

  saveEquitySnapshot(snapshot: SwingEquitySnapshot): void {
    this.db.run(
      'INSERT INTO swing_equity (timestamp, equity, open_positions, day_pnl) VALUES (?, ?, ?, ?)',
      [snapshot.timestamp.toISOString(), snapshot.equity, snapshot.openPositions, snapshot.dayPnl],
    );
  }

  getEquityCurve(limit: number = 200): SwingEquitySnapshot[] {
    return this.db.query<{
      timestamp: string; equity: number; open_positions: number; day_pnl: number;
    }>('SELECT * FROM swing_equity ORDER BY timestamp DESC LIMIT ?', [limit])
      .reverse()
      .map((r) => ({
        timestamp: new Date(r.timestamp),
        equity: r.equity,
        openPositions: r.open_positions,
        dayPnl: r.day_pnl,
      }));
  }

  // ── Stats ──

  getStats(currentEquity: number, paperBalance: number): SwingEngineStats {
    const trades = this.db.query<{ pnl: number }>('SELECT pnl FROM swing_trades');
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);

    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    // Max drawdown from equity curve
    const curve = this.db.query<{ equity: number }>('SELECT equity FROM swing_equity ORDER BY timestamp ASC');
    let peak = 0;
    let maxDd = 0;
    for (const { equity } of curve) {
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }

    return {
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnl,
      averagePnl: trades.length > 0 ? totalPnl / trades.length : 0,
      maxDrawdown: maxDd,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      averageWin: wins.length > 0 ? grossWin / wins.length : 0,
      averageLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      bestTrade: trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0,
      worstTrade: trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0,
      currentEquity,
      paperBalance,
    };
  }

  // ── Config ──

  saveConfig(config: SwingEngineConfig): void {
    this.db.run('INSERT OR REPLACE INTO swing_config (key, value) VALUES (?, ?)', [
      'engine_config',
      JSON.stringify(config),
    ]);
  }

  loadConfig(): SwingEngineConfig | null {
    const row = this.db.query<{ value: string }>('SELECT value FROM swing_config WHERE key = ? LIMIT 1', ['engine_config'])[0];
    if (!row) return null;
    try {
      return JSON.parse(row.value) as SwingEngineConfig;
    } catch {
      return null;
    }
  }
}
