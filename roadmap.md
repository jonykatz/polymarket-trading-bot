# Roadmap — Polymarket short-horizon bot

Ideas y trabajo pendiente. Orden sugerido de implementación.

---

## En progreso / próximo

_Nada en curso._

---

## Pendiente — Ejecución CLOB (FOK → FAK + slippage)

**Contexto (jun 2026, `dev:single-trade`)**

- Auth CLOB y `POLY_1271` OK tras upgrade `@polymarket/clob-client-v2@1.0.6`.
- Entrada live falló cerca del cierre (~22 s): `order couldn't be fully filled. FOK orders are fully filled or killed. status=400`.
- Hoy `buy()` / `sell()` usan **FOK** fijo; `priceLimit` = precio exacto del tick (sin margen).

### Objetivo

Entrar y salir con más éxito en mercados BTC 5m (liquidez fina al final de la ventana), sin sorpresas de sizing.

### 1. Tipo de orden configurable

- [ ] Env `CLOB_ORDER_TYPE=FOK|FAK` (default `FOK` para no cambiar comportamiento actual).
- [ ] **FAK**: fill parcial OK (ej. querés $1, entra $0.89 si no hay más liquidez).
- [ ] Ajustar `LivePosition` / close logic para posiciones con `sizeUsd` / shares menores al planeado.

### 2. Slippage configurable en entrada/salida

- [ ] Env `ENTRY_SLIPPAGE` / `EXIT_SLIPPAGE` (ej. `0.02` = 2 centavos sobre el quote del tick).
- [ ] BUY: `priceLimit = quote + entrySlippage` (cap 0.99).
- [ ] SELL: `priceLimit = quote - exitSlippage` (floor 0.01).

### 3. Gate de tiempo (opcional, mismo epic)

- [ ] No abrir live si `remainingSec` < umbral (ej. 60 s) — evitar FOK/FAK contra book vacío al settlement.

### 4. Probe CLOB sin órdenes reales

- [ ] Cambiar `scripts/clob-order-probe.mjs` / `npm run clob:probe-order` a **solo lectura** (balance + auth + tick size), o confirmación explícita antes de postear orden.

### Criterios de aceptación

- `dev:single-trade` completa al menos un ciclo buy→sell en BTC 5m sin FOK kill por liquidez en condiciones normales.
- FAK documentado: posición puede ser < `MAX_POSITION_USD`; webhook/JSON reflejan fill real.
- Probe nunca gasta USDC sin opt-in.

### Archivos tocados (estimado)

- `src/connectors/orderExecution.ts`, `src/config.ts`, `src/main.ts`, `.env.example`
- `scripts/clob-order-probe.mjs`
- `CHANGELOG.md` al mergear

---

## Pendiente — Binance 429 y BTC features (Railway)

**Contexto (logs Railway, mayo 2026)**

- El bot llama `GET /fapi/v1/klines` en **cada loop** (~15 s) vía `getBtcMarketSnapshot()` → `loadBtcFeatures()` en `src/engine/features.ts`.
- Errores intermitentes: `429` / `-1003`, límite **2400 req/min por IP** (`34.87.100.13`, IP compartida GCP/Railway).
- Cuando falla: `btcScore = 0`, confianza baja; el loop de Polymarket sigue.
- Las velas son **1m**; refrescar REST cada 15 s es redundante (cambio útil ~cada 60 s).

### 1. Caché REST (rápido, alto impacto)

- [ ] En `src/connectors/binance.ts`: guardar último `BtcMarketSnapshot` + timestamp.
- [ ] TTL por defecto **55–60 s** (config: `BINANCE_SNAPSHOT_TTL_SEC`).
- [ ] `getBtcMarketSnapshot()`: devolver caché si fresco; si no, un solo REST.
- [ ] En **429**: devolver caché **stale** si existe (no caer a `btcScore = 0` de golpe).
- [ ] Documentar en `.env.example` y README (solo vars nuevas).

### 2. WebSocket Futures (recomendado por Binance)

- [ ] Módulo singleton, ej. `src/connectors/binanceStream.ts`.
- [ ] Conectar: `wss://fstream.binance.com/ws/btcusdt@kline_1m` (alineado con `BINANCE_REST_BASE` / fapi).
- [ ] Mantener ring buffer de ~6 closes; actualizar al cerrar vela (`k.x === true`).
- [ ] `getBtcMarketSnapshot()`: leer primero del stream; REST solo fallback.
- [ ] Reconnect con backoff; flag config `BINANCE_USE_WEBSOCKET=true`.

### 3. Backoff ante rate limit

- [ ] Tras 429: no hacer REST durante **60–120 s** (`BINANCE_REST_COOLDOWN_SEC`).
- [ ] Log claro: `using stale BTC snapshot` vs `BTC unavailable`.

### 4. Ops / Railway (sin código o mínimo)

- [ ] Confirmar **una sola réplica** del bot en producción.
- [ ] Revisar si otro servicio en el mismo proyecto usa Binance en la misma IP.
- [ ] Mitigación temporal: `BINANCE_SNAPSHOT_TTL_SEC=60` o `BINANCE_FEATURES_ENABLED=false`.

### Criterios de aceptación

- En producción: sin ráfagas de `BTC features unavailable` cada pocos minutos.
- Como mucho **~1 request REST/min** por réplica (con caché), o **0** con WS estable.
- Tras 429: señal BTC sigue con snapshot stale hasta que REST/WS recupere.

### Archivos tocados (estimado)

- `src/connectors/binance.ts`
- `src/connectors/binanceStream.ts` (nuevo)
- `src/config.ts`, `.env.example`
- Opcional: `CHANGELOG.md` al mergear

---

## Backlog (otras ideas)

_Añadir aquí cuando surjan._

---

## Hecho

_Vaciar ítems aquí al completarlos._
