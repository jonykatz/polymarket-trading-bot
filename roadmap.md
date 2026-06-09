# Roadmap — Polymarket short-horizon bot

Ideas y trabajo pendiente. Orden sugerido de implementación.

---

## En progreso / próximo

**Paquete ejecución live (jun 2026)** — prioridad tras logs `dev:single-trade` (FAK kill en YES ~0.56, reintentos en bucle).

1. **Stop retry BUY + log honesto**
   - [ ] Máx 1–3 intentos de buy por `marketId`; si falla → no reintentar hasta el próximo mercado 5m.
   - [ ] Si `LIVE BUY failed`, no loguear `OPEN YES/NO` como si hubiera entrado.
   - [ ] `single-trade`: si no hay fill tras N intentos → JSON `{ "recordType": "NO_TRADE", ... }` y exit.

2. **Salida más robusta**
   - [ ] `EXIT_SLIPPAGE` en `.env` — SELL limit = `quote - exitSlippage` (floor 0.01), no fijo `0.01`.
   - [ ] Subir ventana de cierre: probar `FORCE_EXIT_SECONDS=30–60` (hoy 3 s es muy justo).
   - [ ] Evaluar **FAK en sell** o reintentos escalonados si FOK falla antes del settlement.

3. **Gate de tiempo entrada live**
   - [ ] No abrir live si `remainingSec` < umbral (ej. 60 s) — evita FAK contra book vacío.
   - [ ] Opcional: slippage dinámico en precios extremos (`max(ENTRY_SLIPPAGE, quote * 0.05)`).

4. **JSON n8n / Sheets**
   - [x] `recordType`, `exitMethod`, `settlementOutcome`, `exitErrorMsg` en cierres live.
   - [ ] Campos desglosados: `entryNotionalUsd`, `entryFeeUsd`, `entryCashOutUsd`.
   - [x] `balanceUsdcAtEntry`, `balanceUsdcAtExit`, `polymarketFeePct` (null si no hay snapshot).
   - [x] Precios redondeados en payload.

---

## Pendiente — Ejecución CLOB (resto)

**Contexto actual**

- `buy()` → **FAK**; `sell()` → **FOK** fijo (`src/connectors/orderExecution.ts`).
- `ENTRY_SLIPPAGE` + cap `ENTRY_PRICE_MAX=0.95` en live (`src/engine/paperTrader.ts`, `src/main.ts`).
- Trades NO ~0.50 entran bien con $1; YES ~0.90+ falla a menudo: `no orders found to match with FAK order`.
- Con `MAX_POSITION_USD=100` el riesgo de FAK parcial + FOK sell fail sube ~×100 — no escalar hasta validar fills.

### Tipo de orden configurable

- [ ] Env `CLOB_BUY_ORDER_TYPE` / `CLOB_SELL_ORDER_TYPE` = `FOK|FAK` (defaults actuales).
- [ ] Posición FAK parcial: `sizeUsd` / shares en JSON = fill real, no `MAX_POSITION_USD` planeado.

### Probe CLOB sin órdenes reales

- [ ] `scripts/clob-order-probe.mjs` / `npm run clob:probe-order` → solo lectura (balance + auth + tick size) o confirmación explícita antes de orden (~$1 real hoy).

### Sizing gradual

- [ ] Checklist antes de subir size: BUY fill ≥95%, SELL cierra, JSON cuadra con Polymarket.
- [ ] Ruta sugerida: $1 → $5 → $25 → $100.

### Criterios de aceptación

- `dev:single-trade` buy→sell en BTC 5m sin bucle de FAK failed.
- Sin entradas live en últimos 60 s del mercado (configurable).
- Probe nunca gasta USDC sin opt-in.

### Archivos (estimado)

- `src/connectors/orderExecution.ts`, `src/config.ts`, `src/main.ts`, `src/engine/liveTrader.ts`, `src/engine/tradeWebhook.ts`, `.env.example`

---

## Pendiente — Señal (whale + RSI)

**Contexto:** `whaleSignal=0` casi siempre en BTC 5m; umbrales altos + pocas wallets + winrate default 0.5.

- [ ] Log diagnóstico por tick: notional whale, wallets que pasan filtro, umbral vs actual.
- [ ] Umbrales más bajos solo 5m, o peso whale=0 hasta tunear (`src/engine/predictor.ts`, `polymarket.ts`).
- [ ] Revisar `rsi=0.0` en logs — buffer corto o piso neutro (50) si distorsiona confianza.

---

## Pendiente — Binance 429 y BTC features (Railway)

**Contexto (logs Railway, mayo 2026)**

- REST `/fapi/v1/klines` cada loop (~15 s) → 429 en IP compartida.
- Caché 60 s + stale fallback **implementado** en `src/connectors/binance.ts` (ver CHANGELOG).

### Resto

- [ ] WebSocket `btcusdt@kline_1m` + reconnect backoff (`BINANCE_USE_WEBSOCKET`).
- [ ] Cooldown REST tras 429 (`BINANCE_REST_COOLDOWN_SEC`).
- [ ] Ops: una sola réplica Railway; revisar otros servicios en misma IP.

---

## Backlog (otras ideas)

- [ ] Liquidez pre-trade: leer depth del book y cap `MAX_POSITION_USD` al size fillable.
- [ ] `single-trade` timeout global (ej. 15 min sin trade → exit).
- [ ] Comparativa paper vs live PnL antes de prod 24/7.
- [ ] Env sugerido documentado: `CONFIDENCE_THRESHOLD=0.82–0.85`, `MAX_POSITION_USD=1–5` en fase test.

---

## Hecho

- [x] `@polymarket/clob-client-v2@1.0.6` — órdenes `POLY_1271` (signer=funder).
- [x] `buy()` FAK, `sell()` FOK; CLOB 400/error → `success: false`.
- [x] `ENTRY_SLIPPAGE`, `ENTRY_PRICE_MAX=0.95`, `liveEntryPriceLimit()`.
- [x] `--single-trade` / `npm run dev:single-trade` + `forceLive`.
- [x] Posiciones live en `.data/open-positions.json` + migración legacy.
- [x] `npm run clob:balance`, `getAccountBalance()`.
- [x] Webhook + JSON cierre: slippage, fees, señales, `executionStatus`.
- [x] Binance snapshot cache + stale fallback (`BINANCE_SNAPSHOT_TTL_SEC`).
- [x] JSON: `balanceUsdcAtEntry`, `balanceUsdcAtExit`, `polymarketFeePct` (null si no hay snapshot).
- [x] `TRADE_CLOSED_SETTLE` JSON cuando SELL falla y el mercado ya resolvió (`getMarketResolution`, `recordType`, `settlementOutcome`).
