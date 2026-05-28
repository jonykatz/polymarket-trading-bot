import { cfg } from "../config.js";

export type BtcMarketSnapshot = {
  symbol: string;
  price: number;
  return1m: number;
  return5m: number;
  ts: number;
};

type Kline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const DEFAULT_SYMBOL = "BTCUSDT";
const REQUEST_TIMEOUT_MS = 10_000;

function restBase(): string {
  return cfg.binanceRestBase.replace(/\/$/, "");
}

function apiPrefix(): string {
  const base = restBase();
  if (base.includes("fapi.")) return "/fapi/v1";
  return "/api/v3";
}

async function fetchJson<T>(path: string, query: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const url = `${restBase()}${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance request failed (${res.status}) ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function parseKline(raw: unknown[]): Kline {
  const close = Number(raw[4]);
  if (!Number.isFinite(close)) {
    throw new Error("Binance kline row has invalid close price");
  }
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close
  };
}

function returnBetween(closes: number[], barsBack: number): number {
  const end = closes[closes.length - 1];
  const start = closes[closes.length - 1 - barsBack];
  if (!Number.isFinite(start) || start === 0) return 0;
  return (end - start) / start;
}

export async function getBtcPrice(symbol = DEFAULT_SYMBOL): Promise<number> {
  const data = await fetchJson<{ price: string }>(`${apiPrefix()}/ticker/price`, { symbol });
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid BTC price from Binance: ${data.price}`);
  }
  return price;
}

export async function getBtcKlines(
  symbol = DEFAULT_SYMBOL,
  interval = "1m",
  limit = 6
): Promise<Kline[]> {
  const data = await fetchJson<unknown[][]>(`${apiPrefix()}/klines`, {
    symbol,
    interval,
    limit: String(limit)
  });
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(`Binance klines too short (got ${Array.isArray(data) ? data.length : 0} rows)`);
  }
  return data.map((row) => parseKline(row));
}

/** 1m candles covering [startUnixSec, startUnixSec + windowSec] for historical 5m market resolution. */
export async function getBtcKlinesForWindow(
  startUnixSec: number,
  windowSec = 300,
  symbol = DEFAULT_SYMBOL
): Promise<Kline[]> {
  const startMs = startUnixSec * 1000;
  const endMs = (startUnixSec + windowSec) * 1000;
  const data = await fetchJson<unknown[][]>(`${apiPrefix()}/klines`, {
    symbol,
    interval: "1m",
    startTime: String(startMs - 60_000),
    endTime: String(endMs + 60_000),
    limit: "12"
  });
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`Binance klines empty for window start=${startUnixSec}`);
  }
  return data.map((row) => parseKline(row));
}

export async function getBtcMarketSnapshot(symbol = DEFAULT_SYMBOL): Promise<BtcMarketSnapshot> {
  try {
    const klines = await getBtcKlines(symbol, "1m", 6);
    const closes = klines.map((k) => k.close);
    const price = closes[closes.length - 1];
    const barsFor5m = Math.min(5, closes.length - 1);

    return {
      symbol,
      price,
      return1m: closes.length >= 2 ? returnBetween(closes, 1) : 0,
      return5m: barsFor5m > 0 ? returnBetween(closes, barsFor5m) : 0,
      ts: Date.now()
    };
  } catch (error) {
    console.error("getBtcMarketSnapshot failed:", error);
    throw new Error(
      `Could not load BTC market data from Binance (${cfg.binanceRestBase}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function verifyBinanceReadiness(): Promise<{
  ok: boolean;
  snapshot?: BtcMarketSnapshot;
  error?: string;
}> {
  try {
    const snapshot = await getBtcMarketSnapshot();
    return { ok: true, snapshot };
  } catch (error: unknown) {
    const err = error as Error;
    return { ok: false, error: err.message ?? String(error) };
  }
}
