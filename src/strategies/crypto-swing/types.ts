/**
 * Crypto Swing Trading — Type Definitions
 */

export type SwingSymbol = 'ETH' | 'SOL' | 'PEPE';
export type SwingMode = 'paper' | 'live';
export type SwingSide = 'long' | 'short';
export type SwingExitReason = 'stop_loss' | 'take_profit' | 'trailing_stop' | 'signal_reversal' | 'manual';

export type SwingExecVenue = 'binance' | 'hyperliquid' | 'jupiter' | 'uniswap' | 'paper';

export interface SwingSignal {
  symbol: SwingSymbol;
  side: SwingSide;
  strength: number; // 0-1
  reason: string;
  timestamp: Date;
}

export interface SwingPosition {
  id: string;
  symbol: SwingSymbol;
  side: SwingSide;
  entryPrice: number;
  currentPrice: number;
  sizeUsd: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number | null;
  highWaterMark: number;
  entryTime: Date;
  venue: SwingExecVenue;
  mode: SwingMode;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface SwingTrade {
  id: string;
  symbol: SwingSymbol;
  side: SwingSide;
  entryPrice: number;
  exitPrice: number;
  sizeUsd: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  entryTime: Date;
  exitTime: Date;
  exitReason: SwingExitReason;
  venue: SwingExecVenue;
  mode: SwingMode;
}

export interface SwingEquitySnapshot {
  timestamp: Date;
  equity: number;
  openPositions: number;
  dayPnl: number;
}

export interface SwingEngineConfig {
  mode: SwingMode;
  symbols: SwingSymbol[];
  initialCapital: number;
  maxPositionSizeUsd: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  ohlcvInterval: string;
  evalIntervalMs: number;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  stopLossAtrMultiplier: number;
  takeProfitRatio: number;
  trailingStopEnabled: boolean;
  slippageBps: number;
  feeBps: number;
  binance?: { apiKey: string; apiSecret: string };
  hyperliquid?: { walletAddress: string; privateKey: string };
}

export interface SwingEngineStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
  maxDrawdown: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  bestTrade: number;
  worstTrade: number;
  currentEquity: number;
  paperBalance: number;
}

export interface SwingEngine {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  getConfig(): SwingEngineConfig;
  updateConfig(partial: Partial<SwingEngineConfig>): void;
  getPositions(): SwingPosition[];
  getTrades(limit?: number): SwingTrade[];
  getStats(): SwingEngineStats;
  getEquityCurve(limit?: number): SwingEquitySnapshot[];
  closePosition(symbol: SwingSymbol, reason?: SwingExitReason): Promise<boolean>;
  getMode(): SwingMode;
}

export const DEFAULT_SWING_CONFIG: SwingEngineConfig = {
  mode: 'paper',
  symbols: ['ETH', 'SOL', 'PEPE'],
  initialCapital: 10000,
  maxPositionSizeUsd: 500,
  maxPositionPct: 0.1,
  maxOpenPositions: 3,
  ohlcvInterval: '4h',
  evalIntervalMs: 900_000, // 15 min
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  rsiOverbought: 65,
  rsiOversold: 35,
  stopLossAtrMultiplier: 1.5,
  takeProfitRatio: 2,
  trailingStopEnabled: true,
  slippageBps: 10,
  feeBps: 10,
};
