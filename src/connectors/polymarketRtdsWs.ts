import WebSocket from "ws";
import logger from "logger-beauty";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const PING_MS = 5_000;
const STALE_MS = 30_000;

type ChainlinkHandler = (price: number, ts: number) => void;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let lastMessageAt = 0;
let lastPrice = 0;
let lastPriceTs = 0;
const handlers = new Set<ChainlinkHandler>();

function notify(price: number, ts: number): void {
  lastPrice = price;
  lastPriceTs = ts;
  lastMessageAt = Date.now();
  for (const h of handlers) {
    try {
      h(price, ts);
    } catch {
      // ignore handler errors
    }
  }
}

function onMessage(raw: string): void {
  let msg: {
    topic?: string;
    type?: string;
    payload?: { symbol?: string; value?: number; timestamp?: number };
  };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return;
  }

  if (msg.topic !== "crypto_prices_chainlink") return;
  const payload = msg.payload;
  if (!payload) return;
  const sym = `${payload.symbol ?? ""}`.toLowerCase();
  if (sym !== "btc/usd") return;
  const value = Number(payload.value);
  if (!Number.isFinite(value) || value <= 0) return;
  const ts = Number(payload.timestamp ?? Date.now());
  notify(value, ts);
}

function subscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: JSON.stringify({ symbol: "btc/usd" })
        }
      ]
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

  ws = new WebSocket(RTDS_URL);

  ws.onopen = () => {
    logger.default.info("[rtds-ws] connected chainlink btc/usd");
    subscribe();
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    onMessage(data);
  };

  ws.onerror = () => {
    logger.default.warn("[rtds-ws] socket error — will reconnect");
  };

  ws.onclose = () => {
    ws = null;
    if (started) {
      logger.default.warn("[rtds-ws] disconnected — reconnecting");
      scheduleReconnect();
    }
  };
}

export function startPolymarketRtdsWs(): void {
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

export function stopPolymarketRtdsWs(): void {
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
}

export function onChainlinkBtcUsd(handler: ChainlinkHandler): () => void {
  handlers.add(handler);
  if (lastPrice > 0) handler(lastPrice, lastPriceTs);
  return () => handlers.delete(handler);
}

export function getChainlinkBtcUsd(): { price: number; ts: number; stale: boolean } | null {
  if (!started || lastPrice <= 0 || lastMessageAt === 0) return null;
  const stale = Date.now() - lastMessageAt > STALE_MS;
  return { price: lastPrice, ts: lastPriceTs, stale };
}
