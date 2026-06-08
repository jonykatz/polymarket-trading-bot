import { FeatureVector, Prediction } from "../types/index.js";

export function predict(features: FeatureVector, llmBias: number): Prediction {
  const whaleNet = features.winrateWhaleYesPressure - features.winrateWhaleNoPressure;
  const whaleSignal = features.winrateWhaleGross > 0 ? whaleNet / features.winrateWhaleGross : 0;
  const whaleIntensity = Math.min(1, features.winrateWhaleGross / 10000);
  const z =
    2.2 * features.trendScore +
    2.0 * features.btcScore +
    2.8 * whaleSignal * whaleIntensity +
    0.8 * llmBias;

  const p5m = sigmoid(z);
  const confidence = Math.min(0.99, Math.abs(p5m - 0.5) * 2);
  const side = p5m >= 0.5 ? "YES" : "NO";
  const btcLabel = features.btcSnapshotStale
    ? `STALE:${features.btcScore.toFixed(3)}`
    : features.btcScore.toFixed(3);

  return {
    marketId: features.marketId,
    pUp5m: p5m,
    confidence,
    side,
    reason:
      `trend=${features.trendScore.toFixed(3)} btc=${btcLabel} ` +
      `r1m=${(features.btcReturn1m * 100).toFixed(2)}% r5m=${(features.btcReturn5m * 100).toFixed(2)}% ` +
      `emaSig=${features.emaSignal.toFixed(3)} rsi=${features.rsi.toFixed(1)} ` +
      `whale=${whaleSignal.toFixed(3)} count=${features.winrateWhaleCount} llm=${llmBias.toFixed(2)}`,
    ts: Date.now()
  };
}

function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}
