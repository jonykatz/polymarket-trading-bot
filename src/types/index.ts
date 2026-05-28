export type Side = "YES" | "NO";

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
}
