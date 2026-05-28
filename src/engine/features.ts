import { cfg } from "../config.js";
import { FeatureVector, MarketTick, WhaleFlow } from "../types/index.js";

export function buildFeatures(
  ticks: MarketTick[],
  whale: WhaleFlow,
  walletWinrates: Map<string, number>
): FeatureVector {
  if (ticks.length < 3) throw new Error("Not enough ticks");
  const latest = ticks[ticks.length - 1];

  const prices = ticks.map((t) => t.yesPrice);
  const emaFast = ema(prices, cfg.emaFast);
  const emaSlow = ema(prices, cfg.emaSlow);
  const rsi = calcRsi(prices, cfg.rsiPeriod);
  const emaSignal = emaSlow === 0 ? 0 : (emaFast - emaSlow) / emaSlow;

  const rsiNorm = (rsi - 50) / 50;
  const trendScore = clamp1(0.7 * emaSignal + 0.3 * rsiNorm);

  let yesPressure = 0;
  let noPressure = 0;
  let gross = 0;
  let count = 0;

  for (const p of whale.participants ?? []) {
    const wr = walletWinrates.get(p.wallet) ?? 0.5;
    if (wr < cfg.whaleMinWinrate) continue;
    yesPressure += p.yesNotional * wr;
    noPressure += p.noNotional * wr;
    gross += p.gross;
    count += 1;
  }
  const bal = gross > 0 ? (yesPressure - noPressure) / gross : 0;

  return {
    marketId: latest.marketId,
    yesPrice: latest.yesPrice,
    emaFast,
    emaSlow,
    emaSignal,
    rsi,
    trendScore,
    winrateWhaleYesPressure: yesPressure,
    winrateWhaleNoPressure: noPressure,
    winrateWhaleBalance: bal,
    winrateWhaleCount: count,
    winrateWhaleGross: gross,
    ts: Date.now()
  };
}

function ema(prices: number[], period: number): number {
  if (!prices.length) return 0;
  const alpha = 2 / (period + 1);
  let out = prices[0];
  for (let i = 1; i < prices.length; i += 1) {
    out = alpha * prices[i] + (1 - alpha) * out;
  }
  return out;
}

function calcRsi(prices: number[], period: number): number {
  if (prices.length < 2) return 50;
  let gain = 0;
  let loss = 0;
  const start = Math.max(1, prices.length - period);
  for (let i = start; i < prices.length; i += 1) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gain += d;
    else loss += Math.abs(d);
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
