import { cfg } from "../config.js";
import { resolveAccountWallet } from "./accountActivity.js";

/** Row from GET /positions (Polymarket Data API). */
export type ApiPosition = {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
};

export type FetchAccountPositionsOpts = {
  wallet?: string;
  /** Min position size (API default 1). Use 0.01 for spike on small test positions. */
  sizeThreshold?: number;
  limit?: number;
  offset?: number;
  market?: string[];
  redeemable?: boolean;
};

export async function fetchAccountPositions(
  opts: FetchAccountPositionsOpts = {}
): Promise<ApiPosition[]> {
  const wallet = resolveAccountWallet(opts.wallet);
  const base = cfg.polymarketDataApiBase.replace(/\/$/, "");
  const params = new URLSearchParams({
    user: wallet,
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
    sortBy: "TOKENS",
    sortDirection: "DESC"
  });

  if (opts.sizeThreshold != null) {
    params.set("sizeThreshold", String(opts.sizeThreshold));
  }
  if (opts.redeemable != null) {
    params.set("redeemable", String(opts.redeemable));
  }
  if (opts.market?.length) {
    params.set("market", opts.market.join(","));
  }

  const url = `${base}/positions?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Polymarket /positions failed (${res.status}): ${body.slice(0, 300) || res.statusText}`
    );
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Polymarket /positions returned non-array JSON");
  }
  return data as ApiPosition[];
}

export function isBtc5mPosition(pos: ApiPosition): boolean {
  const slug = `${pos.eventSlug ?? ""} ${pos.slug ?? ""}`.toLowerCase();
  return slug.includes("btc-updown-5m");
}
