/**
 * Crypto Swing Trading — Paper Executor
 *
 * Simulates realistic fills with slippage and fees.
 */

import { logger } from '../../utils/logger.js';
import type {
  SwingPosition,
  SwingTrade,
  SwingSymbol,
  SwingSide,
  SwingExitReason,
  SwingEngineConfig,
} from './types.js';

export class PaperExecutor {
  private balance: number;

  constructor(private config: SwingEngineConfig) {
    this.balance = config.initialCapital;
  }

  getBalance(): number {
    return this.balance;
  }

  setBalance(balance: number): void {
    this.balance = balance;
  }

  openPosition(
    symbol: SwingSymbol,
    side: SwingSide,
    sizeUsd: number,
    currentPrice: number,
    stopLoss: number,
    takeProfit: number,
  ): SwingPosition | null {
    if (sizeUsd > this.balance) {
      logger.warn({ symbol, sizeUsd, balance: this.balance }, '[PaperExec] Insufficient balance');
      return null;
    }

    // Apply slippage — worse fill
    const slippageMult = this.config.slippageBps / 10000;
    const fillPrice = side === 'long'
      ? currentPrice * (1 + slippageMult)
      : currentPrice * (1 - slippageMult);

    const fees = sizeUsd * (this.config.feeBps / 10000);
    const netSize = sizeUsd - fees;
    const quantity = netSize / fillPrice;

    this.balance -= sizeUsd;

    const id = `paper_${symbol}_${Date.now()}`;

    logger.info(
      { symbol, side, fillPrice, quantity, sizeUsd, fees },
      '[PaperExec] Opened position',
    );

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
      venue: 'paper',
      mode: 'paper',
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
    };
  }

  closePosition(
    position: SwingPosition,
    currentPrice: number,
    reason: SwingExitReason,
  ): SwingTrade {
    // Apply slippage — worse fill on exit
    const slippageMult = this.config.slippageBps / 10000;
    const fillPrice = position.side === 'long'
      ? currentPrice * (1 - slippageMult)
      : currentPrice * (1 + slippageMult);

    const exitValue = position.quantity * fillPrice;
    const fees = exitValue * (this.config.feeBps / 10000);
    const netExit = exitValue - fees;

    const rawPnl = position.side === 'long'
      ? (fillPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - fillPrice) * position.quantity;

    const totalFees = position.sizeUsd * (this.config.feeBps / 10000) + fees;
    const pnl = rawPnl - fees; // entry fees already deducted from sizeUsd

    this.balance += netExit;

    logger.info(
      { symbol: position.symbol, side: position.side, fillPrice, pnl, reason },
      '[PaperExec] Closed position',
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
      fees: totalFees,
      entryTime: position.entryTime,
      exitTime: new Date(),
      exitReason: reason,
      venue: 'paper',
      mode: 'paper',
    };
  }

  updateConfig(config: SwingEngineConfig): void {
    this.config = config;
  }
}
