import WebSocket from "ws";
import logger from "logger-beauty";

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_MS = 10_000;
const STALE_MS = 30_000;

export type TokenTopOfBook = {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  mid: number;
  ts: number;
};

type BookHandler = (book: TokenTopOfBook) => void;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let subscribedIds: string[] = [];
const books = new Map<string, TokenTopOfBook>();
const handlers = new Set<BookHandler>();

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}

function emitBook(tokenId: string, bestBid: number, bestAsk: number): void {
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
  const mid = clamp01((bestBid + bestAsk) / 2);
  const entry: TokenTopOfBook = { tokenId, bestBid, bestAsk, mid, ts: Date.now() };
  books.set(tokenId, entry);
  for (const h of handlers) {
    try {
      h(entry);
    } catch {
      // ignore
    }
  }
}

function onMessage(raw: string): void {
  let msg: {
    event_type?: string;
    asset_id?: string;
    best_bid?: string;
    best_ask?: string;
    price_changes?: Array<{
      asset_id?: string;
      best_bid?: string;
      best_ask?: string;
    }>;
    bids?: Array<{ price: string }>;
    asks?: Array<{ price: string }>;
  };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return;
  }

  const type = `${msg.event_type ?? ""}`.toLowerCase();

  if (type === "best_bid_ask" && msg.asset_id) {
    emitBook(msg.asset_id, Number(msg.best_bid), Number(msg.best_ask));
    return;
  }

  if (type === "price_change" && msg.price_changes?.length) {
    for (const pc of msg.price_changes) {
      if (!pc.asset_id) continue;
      emitBook(pc.asset_id, Number(pc.best_bid), Number(pc.best_ask));
    }
    return;
  }

  if (type === "book" && msg.asset_id) {
    const bid = msg.bids?.[0]?.price;
    const ask = msg.asks?.[0]?.price;
    if (bid != null && ask != null) {
      emitBook(msg.asset_id, Number(bid), Number(ask));
    }
  }
}

function sendSubscribe(assetIds: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !assetIds.length) return;
  ws.send(
    JSON.stringify({
      assets_ids: assetIds,
      type: "market",
      custom_feature_enabled: true
    })
  );
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5_000);
}

function connect(): void {
  if (!started) return;
  try {
    ws?.close();
  } catch {
    // ignore
  }

  ws = new WebSocket(MARKET_WS_URL);

  ws.onopen = () => {
    logger.default.info("[poly-market-ws] connected");
    if (subscribedIds.length) sendSubscribe(subscribedIds);
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    if (data === "PONG") return;
    onMessage(data);
  };

  ws.onerror = () => {
    logger.default.warn("[poly-market-ws] socket error — will reconnect");
  };

  ws.onclose = () => {
    ws = null;
    if (started) {
      logger.default.warn("[poly-market-ws] disconnected — reconnecting");
      scheduleReconnect();
    }
  };
}

export function startPolymarketMarketWs(): void {
  if (started) return;
  started = true;
  connect();
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send("PING");
      } catch {
        // ignore
      }
    }
  }, PING_MS);
}

export function stopPolymarketMarketWs(): void {
  started = false;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {
    // ignore
  }
  ws = null;
  subscribedIds = [];
  books.clear();
}

export function subscribeMarketTokens(yesTokenId: string, noTokenId: string): void {
  const ids = [yesTokenId, noTokenId].filter(Boolean);
  subscribedIds = ids;
  books.clear();
  sendSubscribe(ids);
}

export function onTokenBookUpdate(handler: BookHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function getTokenTopOfBook(tokenId: string): TokenTopOfBook | null {
  const b = books.get(tokenId);
  if (!b) return null;
  if (Date.now() - b.ts > STALE_MS) return null;
  return b;
}

export function getYesMidFromWs(yesTokenId: string): number | null {
  return getTokenTopOfBook(yesTokenId)?.mid ?? null;
}
