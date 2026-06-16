import type { Side } from "../types/index.js";

const FAIR_ADJUST_CAP = 0.3;
const FAIR_ADJUST_SCALE = 5.0;
const TIME_DECAY_FLOOR = 0.05;
const MIN_ABS_DELTA = 0.0005;

export type DislocationSignal = {
  marketId: string;
  side: Side;
  fairYes: number;
  yesPrice: number;
  edge: number;
  edgeYes: number;
  edgeNo: number;
  deltaBtc: number;
  remainingSec: number;
  btcPrice: number;
  btcWindowStart: number;
  reason: string;
  ts: number;
};

function clampFairYes(v: number): number {
  return Math.max(0.2, Math.min(0.8, v));
}

export function computeDislocation(input: {
  marketId: string;
  btcPriceNow: number;
  btcPriceWindowStart: number;
  remainingSec: number;
  yesPrice: number;
  minEdge?: number;
}): DislocationSignal | null {
  const { marketId, btcPriceNow, btcPriceWindowStart, remainingSec, yesPrice } = input;
  const minEdge = input.minEdge ?? 0.03;

  if (
    !Number.isFinite(btcPriceNow) ||
    !Number.isFinite(btcPriceWindowStart) ||
    btcPriceWindowStart <= 0 ||
    !Number.isFinite(yesPrice)
  ) {
    return null;
  }

  const deltaBtc = (btcPriceNow - btcPriceWindowStart) / btcPriceWindowStart;
  if (Math.abs(deltaBtc) < MIN_ABS_DELTA) return null;

  const timeDecay = Math.max(remainingSec / 300, TIME_DECAY_FLOOR);
  const sign = deltaBtc >= 0 ? 1 : -1;
  const adjustment = Math.min(FAIR_ADJUST_CAP, (Math.abs(deltaBtc) / timeDecay) * FAIR_ADJUST_SCALE);
  const fairYes = clampFairYes(0.5 + sign * adjustment);

  const edgeYes = fairYes - yesPrice;
  const fairNo = 1 - fairYes;
  const noPrice = 1 - yesPrice;
  const edgeNo = fairNo - noPrice;

  let side: Side;
  let edge: number;
  if (edgeYes >= edgeNo) {
    side = "YES";
    edge = edgeYes;
  } else {
    side = "NO";
    edge = edgeNo;
  }

  if (edge < minEdge) return null;

  return {
    marketId,
    side,
    fairYes,
    yesPrice,
    edge,
    edgeYes,
    edgeNo,
    deltaBtc,
    remainingSec,
    btcPrice: btcPriceNow,
    btcWindowStart: btcPriceWindowStart,
    reason:
      `disloc Δ=${(deltaBtc * 100).toFixed(3)}% fair=${fairYes.toFixed(3)} ` +
      `yes=${yesPrice.toFixed(3)} edge=${edge.toFixed(3)} side=${side}`,
    ts: Date.now()
  };
}

export function computeMakerLimitPrice(input: {
  side: Side;
  fairYes: number;
  bestAsk: number;
  tickSize: number;
  improveBy: number;
}): number {
  const tick = input.tickSize > 0 ? input.tickSize : 0.01;
  const fairToken = input.side === "YES" ? input.fairYes : 1 - input.fairYes;
  const improved = fairToken - input.improveBy;
  const underAsk = input.bestAsk - tick;
  const raw = Math.min(underAsk, improved);
  const factor = 1 / tick;
  return Math.round(raw * factor) / factor;
}
