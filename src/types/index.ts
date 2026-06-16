export type Side = "YES" | "NO";

import type { PredictionSignals } from "../engine/tradeWebhook.js";

export type { PredictionSignals };

export interface MarketTick {
  marketId: string;
  yesPrice: number;
  noPrice: number;
  ts: number;
}

export interface WhaleFlow {
  marketId: string;
  netYesNotional: number;
  grossNotional: number;
  yesNotional: number;
  noNotional: number;
  tradeCount: number;
  ts: number;
  participants?: Array<{
    wallet: string;
    yesNotional: number;
    noNotional: number;
    netYes: number;
    gross: number;
    joinedAt: number;
  }>;
  topWallets?: Array<{
    wallet: string;
    netYes: number;
    gross: number;
  }>;
}

export interface FeatureVector {
  marketId: string;
  yesPrice: number;
  emaFast: number;
  emaSlow: number;
  emaSignal: number;
  rsi: number;
  trendScore: number;
  winrateWhaleYesPressure: number;
  winrateWhaleNoPressure: number;
  winrateWhaleBalance: number;
  winrateWhaleCount: number;
  winrateWhaleGross: number;
  /** Spot/futures BTCUSDT price from Binance at feature build time. */
  btcPrice: number;
  /** Fractional change over ~1m (e.g. 0.001 = +0.1%). */
  btcReturn1m: number;
  /** Fractional change over ~5m. */
  btcReturn5m: number;
  /** Normalized BTC momentum in [-1, 1] for the predictor. */
  btcScore: number;
  /** True when btcScore comes from a cached Binance snapshot (REST failed or TTL reuse). */
  btcSnapshotStale: boolean;
  /** Age in seconds of the cached snapshot when `btcSnapshotStale` is true. */
  btcSnapshotAgeSec?: number;
  ts: number;
}

export interface Prediction {
  marketId: string;
  pUp5m: number;
  confidence: number;
  reason: string;
  side: Side;
  ts: number;
}

export interface Position {
  marketId: string;
  side: Side;
  entryPrice: number;
  sizeUsd: number;
  openedAt: number;
}

export interface LivePosition {
  marketId: string;
  conditionId: string;
  side: Side;
  tokenId: string;
  sizeShares: number;
  openedAt: number;
  /** Quoted/limit price at entry. */
  entryPrice?: number;
  /** Actual fill price from the CLOB buy. */
  entryPriceReal?: number;
  sizeUsd?: number;
  slippageEntry?: number;
  /** Fee rate in bps captured at entry. */
  feeRateBps?: number;
  /** Entry-side fee already paid (USD). */
  entryFeeUsd?: number;
  /** Total USDC debited from wallet on entry (notional + fees). */
  entryCashOutUsd?: number;
  /** CLOB USDC balance snapshot immediately before the buy. */
  balanceUsdcAtEntry?: number;
  entryPriceLimit?: number;
  entryOrderId?: string;
  entryStatus?: string;
  entryAttemptCount?: number;
  pUp5mAtEntry?: number;
  /** Predictor signals at entry for close webhook. */
  signals?: PredictionSignals;
  /** How the position was opened. */
  entryMethod?: "FAK" | "MAKER_GTD";
}
