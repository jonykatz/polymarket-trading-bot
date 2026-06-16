/** Chainlink BTC window-start price keyed by btc-updown-5m slug. */
let activeSlug: string | null = null;
let startBtcPrice: number | null = null;

export function resetWindowBtc(slug: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  activeSlug = slug;
  startBtcPrice = price;
}

export function noteWindowBtc(slug: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  if (slug !== activeSlug) {
    resetWindowBtc(slug, price);
  }
}

export function getWindowBtcStart(slug: string): number | null {
  if (slug !== activeSlug) return null;
  return startBtcPrice;
}

export function deltaBtcInWindow(slug: string, currentPrice: number): number | null {
  const start = getWindowBtcStart(slug);
  if (start == null || start === 0 || !Number.isFinite(currentPrice)) return null;
  return (currentPrice - start) / start;
}
