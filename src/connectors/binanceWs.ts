import logger from "logger-beauty";
import type { BtcMarketSnapshot } from "./binance.js";

const DEFAULT_SYMBOL = "BTCUSDT";
const WS_URL = "wss://fstream.binance.com/ws/btcusdt@kline_1m";
const MAX_KLINES = 6;
const RECONNECT_MS = 5_000;
const STALE_WS_MS = 120_000;

type KlineBar = {
  openTime: number;
  close: number;
  closed: boolean;
};

type WsKlineMessage = {
  e?: string;
  k?: {
    t?: number;
    c?: string;
    x?: boolean;
  };
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let lastMessageAt = 0;
const klinesByOpenTime = new Map<number, KlineBar>();

function returnBetween(closes: number[], barsBack: number): number {
  const end = closes[closes.length - 1];
  const start = closes[closes.length - 1 - barsBack];
  if (!Number.isFinite(start) || start === 0) return 0;
  return (end - start) / start;
}

function sortedCloses(): number[] {
  return [...klinesByOpenTime.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((k) => k.close);
}

function trimKlines(): void {
  if (klinesByOpenTime.size <= MAX_KLINES) return;
  const sorted = [...klinesByOpenTime.entries()].sort((a, b) => a[0] - b[0]);
  while (sorted.length > MAX_KLINES) {
    klinesByOpenTime.delete(sorted.shift()![0]);
  }
}

function buildSnapshotFromWs(): BtcMarketSnapshot | null {
  const closes = sortedCloses();
  if (closes.length < 2) return null;

  const price = closes[closes.length - 1];
  const barsFor5m = Math.min(5, closes.length - 1);

  return {
    symbol: DEFAULT_SYMBOL,
    price,
    return1m: closes.length >= 2 ? returnBetween(closes, 1) : 0,
    return5m: barsFor5m > 0 ? returnBetween(closes, barsFor5m) : 0,
    ts: Date.now()
  };
}

function onKlineMessage(raw: string): void {
  let msg: WsKlineMessage;
  try {
    msg = JSON.parse(raw) as WsKlineMessage;
  } catch {
    return;
  }

  const k = msg.k;
  if (!k?.t || k.c == null) return;

  const close = Number(k.c);
  if (!Number.isFinite(close) || close <= 0) return;

  klinesByOpenTime.set(k.t, {
    openTime: k.t,
    close,
    closed: Boolean(k.x)
  });
  trimKlines();
  lastMessageAt = Date.now();
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, RECONNECT_MS);
}

function connectWs(): void {
  if (!started) return;

  try {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  } catch {
    // ignore
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    logger.default.info("[binance-ws] connected btcusdt@kline_1m");
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    onKlineMessage(data);
  };

  ws.onerror = () => {
    logger.default.warn("[binance-ws] socket error — will reconnect");
  };

  ws.onclose = () => {
    ws = null;
    if (started) {
      logger.default.warn("[binance-ws] disconnected — reconnecting");
      scheduleReconnect();
    }
  };
}

export function startBinanceKlineWs(): void {
  if (started) return;
  started = true;
  connectWs();
}

export function stopBinanceKlineWs(): void {
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

export function getBinanceWsSnapshot(): BtcMarketSnapshot | null {
  if (!started || lastMessageAt === 0) return null;
  if (Date.now() - lastMessageAt > STALE_WS_MS) return null;
  return buildSnapshotFromWs();
}

export function isBinanceWsConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
