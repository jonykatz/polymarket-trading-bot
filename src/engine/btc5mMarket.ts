/** Unix seconds when the 5m window starts (from slug suffix), or null. */
export function btc5mStartSecFromSlug(slug: string): number | null {
  const m = slug.match(/btc-updown-5m-(\d{9,12})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Unix seconds when the 5m window ends (start + 300s), or null. */
export function btc5mEndSecFromSlug(slug: string): number | null {
  const start = btc5mStartSecFromSlug(slug);
  return start != null ? start + 300 : null;
}

/** True when the btc-updown-5m window has ended (plus buffer). Unknown slug → false (conservative). */
export function isBtc5mMarketPastWindowEnd(marketId: string, bufferSec = 2): boolean {
  const endSec = btc5mEndSecFromSlug(marketId);
  if (endSec == null) return false;
  return Math.floor(Date.now() / 1000) >= endSec + bufferSec;
}
