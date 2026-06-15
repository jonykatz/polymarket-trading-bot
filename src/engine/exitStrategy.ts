import { cfg } from "../config.js";
import type { LivePosition, Side } from "../types/index.js";

export type LiveExitTrigger = "take_profit" | "stop_loss" | "force_exit_loss" | "stale";

/** Mark-to-market price for the held side (YES = yesPrice, NO = 1 − yesPrice). */
export function markPriceForSide(side: Side, yesPrice: number): number {
  const mark = side === "YES" ? yesPrice : 1 - yesPrice;
  return Math.round(mark * 1000) / 1000;
}

/** Entry reference: real fill price when available, else quoted entry. */
export function positionEntryPrice(pos: LivePosition): number {
  return pos.entryPriceReal ?? pos.entryPrice ?? 0;
}

/**
 * Fraction of max gain captured: (mark − entry) / (1 − entry).
 * 0 = flat at entry, 1 = at $1.00 payout.
 */
export function gainFractionOfMax(entry: number, mark: number): number {
  if (entry <= 0 || entry >= 1) return 0;
  const maxGain = 1 - entry;
  if (maxGain <= 0) return 0;
  return (mark - entry) / maxGain;
}

export function takeProfitMarkPrice(entry: number): number {
  return entry + cfg.takeProfitPctOfMax * (1 - entry);
}

export function stopLossMarkPrice(entry: number): number {
  return entry * (1 - cfg.stopLossPct);
}

/** Live entry allowed when the 5m window has at least minRemainingSecEntry left. */
export function canEnterByRemainingSec(remainingSec: number): boolean {
  return remainingSec < 0 || remainingSec >= cfg.minRemainingSecEntry;
}

export function liveForceExitWindowSec(): number {
  return cfg.forceExitSeconds + cfg.loopSeconds;
}

export type ExitEvaluation = {
  trigger: LiveExitTrigger | null;
  urgent: boolean;
  entry: number;
  mark: number;
  gainFraction: number;
};

/**
 * Asymmetric exit rules:
 * - take profit when gain ≥ TAKE_PROFIT_PCT_OF_MAX of max upside
 * - stop loss when mark ≤ entry × (1 − STOP_LOSS_PCT)
 * - near expiry: force sell only if losing (mark < entry); winners hold for settlement
 */
export function evaluateLiveExit(input: {
  pos: LivePosition;
  yesPrice: number;
  remainingSec: number;
  isCurrentMarket: boolean;
}): ExitEvaluation {
  const { pos, yesPrice, remainingSec, isCurrentMarket } = input;
  const mark = markPriceForSide(pos.side, yesPrice);
  const entry = positionEntryPrice(pos);
  const gainFraction = gainFractionOfMax(entry, mark);

  if (!isCurrentMarket) {
    return { trigger: "stale", urgent: true, entry, mark, gainFraction };
  }

  if (entry <= 0 || entry >= 1) {
    return { trigger: null, urgent: false, entry, mark, gainFraction };
  }

  if (gainFraction >= cfg.takeProfitPctOfMax) {
    return { trigger: "take_profit", urgent: false, entry, mark, gainFraction };
  }

  if (mark <= stopLossMarkPrice(entry)) {
    return { trigger: "stop_loss", urgent: true, entry, mark, gainFraction };
  }

  const nearExpiry =
    remainingSec >= 0 && remainingSec <= liveForceExitWindowSec();
  if (nearExpiry && mark < entry) {
    return { trigger: "force_exit_loss", urgent: true, entry, mark, gainFraction };
  }

  return { trigger: null, urgent: false, entry, mark, gainFraction };
}

export function exitTriggerLabel(trigger: LiveExitTrigger): string {
  switch (trigger) {
    case "take_profit":
      return "TAKE_PROFIT";
    case "stop_loss":
      return "STOP_LOSS";
    case "force_exit_loss":
      return "FORCE_EXIT_LOSS";
    case "stale":
      return "STALE_MARKET";
  }
}
