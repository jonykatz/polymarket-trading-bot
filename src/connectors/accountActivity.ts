import { cfg } from "../config.js";
import { getSignerAddress } from "./orderExecution.js";

const PAGE_SIZE = 100;
/** Default cap when no --all / --limit (100 × 100 = 10,000 rows). */
const DEFAULT_MAX_ROWS = 10_000;
/** Safety stop for --all pagination (100 × 1,000 = 100,000 rows). */
const ALL_MAX_ROWS = 100_000;

export type ActivityType =
  | "TRADE"
  | "REDEEM"
  | "MERGE"
  | "SPLIT"
  | "REWARD"
  | "CONVERSION"
  | string;

type RawActivityRow = {
  proxyWallet?: string;
  timestamp?: number;
  conditionId?: string;
  type?: string;
  size?: number;
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset?: string;
  side?: string;
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
};

export type AccountMovement = {
  wallet: string;
  timestamp: string;
  timestampSec: number;
  type: ActivityType;
  side: "BUY" | "SELL" | null;
  marketTitle: string;
  marketSlug: string;
  eventSlug: string;
  outcome: string | null;
  shares: number;
  price: number | null;
  /** Negative = cash out (buy), positive = cash in (sell/redeem). Matches Polymarket activity UI. */
  cashFlowUsd: number;
  conditionId: string;
  transactionHash: string;
};

export type TradeLeg = "ENTRY" | "EXIT" | "OTHER";

export type AccountMovementSheet = AccountMovement & {
  movementId: string;
  tradeLeg: TradeLeg;
  feeUsd: number | null;
};

export type FetchAccountMovementsOpts = {
  wallet?: string;
  /** Max rows to return. Omit with fetchAll for full history up to API/safety cap. */
  limit?: number;
  /** Paginate until the API returns no more rows (up to ALL_MAX_ROWS). */
  fetchAll?: boolean;
  type?: ActivityType;
  startSec?: number;
  endSec?: number;
  sortDirection?: "ASC" | "DESC";
};

export function inferTradeLeg(type: ActivityType, side: AccountMovement["side"]): TradeLeg {
  const t = (type ?? "").toUpperCase();
  if (t === "TRADE" && side === "BUY") return "ENTRY";
  if (t === "REDEEM") return "EXIT";
  if (t === "TRADE" && side === "SELL") return "EXIT";
  return "OTHER";
}

export function buildMovementId(movement: Pick<AccountMovement, "transactionHash" | "type" | "side" | "timestampSec">): string {
  const side = movement.side ?? "NONE";
  return `${movement.transactionHash}:${movement.type}:${side}:${movement.timestampSec}`;
}

/** Fee from API price vs wallet cash flow. Always ≤ 0 (cost); REDEEM → 0. */
export function computeFeeUsd(
  movement: Pick<AccountMovement, "type" | "side" | "shares" | "price" | "cashFlowUsd">,
  tradeLeg: TradeLeg
): number | null {
  const { shares, price, cashFlowUsd } = movement;
  const type = (movement.type ?? "").toUpperCase();

  if (tradeLeg === "EXIT" && type === "REDEEM") {
    return 0;
  }
  if (price == null || shares <= 0) return null;

  const notional = roundMoney(shares * price);
  let fee = 0;
  if (tradeLeg === "ENTRY") {
    fee = Math.max(0, Math.abs(cashFlowUsd) - notional);
  } else if (tradeLeg === "EXIT" && type === "TRADE") {
    fee = Math.max(0, notional - cashFlowUsd);
  } else {
    return null;
  }

  return fee === 0 ? 0 : -roundMoney(fee);
}

export function toSheetMovement(movement: AccountMovement): AccountMovementSheet {
  const tradeLeg = inferTradeLeg(movement.type, movement.side);
  return {
    ...movement,
    movementId: buildMovementId(movement),
    tradeLeg,
    feeUsd: computeFeeUsd(movement, tradeLeg)
  };
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Wallet used on Polymarket Data API (proxy/funder profile, else signer). */
export function resolveAccountWallet(override?: string): string {
  const raw = override?.trim() || cfg.clobFunderAddress?.trim() || getSignerAddress();
  return raw.toLowerCase();
}

function signedCashFlow(row: RawActivityRow): number {
  const usdc = roundMoney(Number(row.usdcSize ?? 0));
  const type = (row.type ?? "").toUpperCase();
  const side = (row.side ?? "").toUpperCase();

  if (type === "TRADE") {
    if (side === "BUY") return usdc > 0 ? -usdc : usdc;
    if (side === "SELL") return Math.abs(usdc);
    return usdc;
  }

  if (type === "REDEEM" || type === "REWARD") {
    return Math.abs(usdc);
  }

  return usdc;
}

function normalizeMovement(row: RawActivityRow, wallet: string): AccountMovement | null {
  const timestampSec = Number(row.timestamp ?? 0);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return null;

  const sideRaw = (row.side ?? "").toUpperCase();
  const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

  return {
    wallet,
    timestamp: new Date(timestampSec * 1000).toISOString(),
    timestampSec,
    type: (row.type ?? "UNKNOWN").toUpperCase(),
    side,
    marketTitle: row.title ?? "",
    marketSlug: row.slug ?? "",
    eventSlug: row.eventSlug ?? "",
    outcome: row.outcome?.trim() ? row.outcome : null,
    shares: roundMoney(Number(row.size ?? 0)),
    price: row.price != null && Number.isFinite(row.price) ? roundMoney(row.price) : null,
    cashFlowUsd: signedCashFlow(row),
    conditionId: row.conditionId ?? "",
    transactionHash: row.transactionHash ?? ""
  };
}

async function fetchActivityPage(
  wallet: string,
  offset: number,
  opts: FetchAccountMovementsOpts
): Promise<RawActivityRow[]> {
  const base = cfg.polymarketDataApiBase.replace(/\/$/, "");
  const params = new URLSearchParams({
    user: wallet,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    sortBy: "TIMESTAMP",
    sortDirection: opts.sortDirection ?? "DESC"
  });
  if (opts.type) params.set("type", opts.type);
  if (opts.startSec != null) params.set("start", String(opts.startSec));
  if (opts.endSec != null) params.set("end", String(opts.endSec));

  const res = await fetch(`${base}/activity?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Polymarket activity API failed (${res.status}): ${body.slice(0, 200) || res.statusText}`
    );
  }

  const data = (await res.json()) as RawActivityRow[];
  return Array.isArray(data) ? data : [];
}

/** All account movements from Polymarket Data API `/activity` (trades, redeems, merges, etc.). */
export async function fetchAccountMovements(
  opts: FetchAccountMovementsOpts = {}
): Promise<AccountMovement[]> {
  const wallet = resolveAccountWallet(opts.wallet);
  const maxRows = opts.fetchAll
    ? ALL_MAX_ROWS
    : opts.limit ?? DEFAULT_MAX_ROWS;
  const maxPages = Math.ceil(maxRows / PAGE_SIZE);
  const rows: AccountMovement[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    const batch = await fetchActivityPage(wallet, offset, opts);
    if (batch.length === 0) break;

    for (const raw of batch) {
      const movement = normalizeMovement(raw, wallet);
      if (movement) rows.push(movement);
    }

    if (rows.length >= maxRows || batch.length < PAGE_SIZE) break;
  }

  return rows.slice(0, maxRows);
}

/** Full wallet history (paginates until API exhausted). */
export async function fetchAllAccountMovements(
  opts: Omit<FetchAccountMovementsOpts, "limit" | "fetchAll"> = {}
): Promise<AccountMovement[]> {
  return fetchAccountMovements({ ...opts, fetchAll: true });
}
