/**
 * Technical Analysis Indicators
 *
 * Pure functions operating on number[] arrays.
 * Used by crypto swing trading and other strategies.
 */

/** Exponential Moving Average */
export function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const k = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let prev = sum / period;
  result.push(prev);

  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    result.push(prev);
  }

  return result;
}

/** Simple Moving Average */
export function sma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const result: number[] = [];
  let sum = 0;

  for (let i = 0; i < period; i++) sum += prices[i];
  result.push(sum / period);

  for (let i = period; i < prices.length; i++) {
    sum += prices[i] - prices[i - period];
    result.push(sum / period);
  }

  return result;
}

/** Wilder RSI */
export function rsi(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const result: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  // First period — average of gains/losses
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));

  // Subsequent values — Wilder smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  return result;
}

export interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

/** MACD (Moving Average Convergence Divergence) */
export function macd(
  prices: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MACDResult {
  const fastEma = ema(prices, fastPeriod);
  const slowEma = ema(prices, slowPeriod);

  if (slowEma.length === 0) return { macdLine: [], signalLine: [], histogram: [] };

  // Align: fastEma is longer than slowEma by (slowPeriod - fastPeriod)
  const offset = fastEma.length - slowEma.length;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine.length === 0) return { macdLine, signalLine: [], histogram: [] };

  const histOffset = macdLine.length - signalLine.length;
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + histOffset] - signalLine[i]);
  }

  return { macdLine, signalLine, histogram };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

/** Bollinger Bands */
export function bollinger(
  prices: number[],
  period: number = 20,
  stdDevMult: number = 2,
): BollingerResult {
  const middle = sma(prices, period);
  if (middle.length === 0) return { upper: [], middle: [], lower: [], bandwidth: [] };

  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];

  for (let i = 0; i < middle.length; i++) {
    const slice = prices.slice(i, i + period);
    const mean = middle[i];
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    upper.push(mean + stdDev * stdDevMult);
    lower.push(mean - stdDev * stdDevMult);
    bandwidth.push(mean > 0 ? ((upper[i] - lower[i]) / mean) * 100 : 0);
  }

  return { upper, middle, lower, bandwidth };
}

/** Average True Range */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number[] {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < 2) return [];

  // True Range series
  const tr: number[] = [];
  tr.push(highs[0] - lows[0]); // First bar: just high-low

  for (let i = 1; i < len; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  if (tr.length < period) return [];

  // First ATR is SMA of first `period` TRs
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;

  const result: number[] = [prev];

  // Wilder smoothing
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    result.push(prev);
  }

  return result;
}
