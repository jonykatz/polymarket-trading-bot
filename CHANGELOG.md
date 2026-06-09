# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- Fixed: `src/connectors/orderExecution.ts` derives CLOB L2 credentials with `deriveApiKey` before `createApiKey`, parses V2 `allowances` responses, and auto-probes signature types so `npm run clob:balance` finds deposit-wallet balances (`POLY_1271`).
- Added: `npm run clob:balance` and `getAccountBalance()` in `src/connectors/orderExecution.ts` to print Polymarket CLOB USDC balance via `PRIVATE_KEY` / proxy settings.
- Added: Live close webhook via `src/engine/liveTrader.ts` and shared `src/engine/tradeWebhook.ts`; `src/connectors/orderExecution.ts` parses CLOB fill prices/fees; `LivePosition` stores entry metadata for close payloads (`executionStatus: EXECUTED`).
- Added: `src/engine/paperTrader.ts` close webhook fields `entryPriceReal`, `exitPriceReal`, slippage, fees, `pnlGross`/`pnlNet`, `btcScore`, `btcSnapshotStale`, and `executionStatus` (paper mode uses zeros and `TESTING`).
- Added: `src/connectors/binance.ts` 60s BTC snapshot cache with stale fallback on REST failures (429); `src/engine/features.ts` and `src/engine/predictor.ts` expose `btc=STALE` in logs when using cached data (`BINANCE_SNAPSHOT_TTL_SEC`).
- Added: `src/connectors/binance.ts` and `npm run binance:verify`; `src/engine/features.ts` and `src/engine/predictor.ts` blend BTC momentum (`btcScore`) into signals (`BINANCE_FEATURES_ENABLED=false` to disable).
- Fixed: `src/main.ts` in `PAPER_MODE` now enforces `CONFIDENCE_THRESHOLD` before calling `paperTrader.onPrediction()`, preventing entries when confidence is below threshold.
- Fixed: `src/engine/paperTrader.ts`, `src/main.ts`, `src/models/llmScorer.ts`, `src/config.ts`, and `src/engine/features.ts` now persist predictor signals in PAPER close webhook payloads, default unknown whale winrates to `0.5`, and surface/configure OpenAI errors so `llmBias` no longer fails silently.
- Fixed: `src/engine/paperTrader.ts` and `src/main.ts` enforce one entry per `marketId` per cycle (`enteredMarkets` + loop mutex), reject extreme entry prices, and webhook POST omits `cumulativePnlUsd`/`winRate` (Sheets aggregates).
- Added: `PAPER_MODE` and `WEBHOOK_URL` in `src/config.ts`; `src/connectors/orderExecution.ts` simulates orders without CLOB calls; `src/engine/paperTrader.ts` tracks PnL on settlement and POSTs closed trades to a webhook.
- Fixed: `src/main.ts` paper flow now calls `onPrediction()` for SKIP/OPEN; canonical `marketMeta.slug` avoids duplicate opens when tick `marketId` differs from stored position key.
- Fixed: `src/main.ts` paper entries use `EDGE_THRESHOLD` via `paperTrader.onPrediction()` instead of `CONFIDENCE_THRESHOLD`; `src/engine/paperTrader.ts` settles in the last `LOOP_SECONDS` window so webhooks fire when the loop skips `remainingSec === 0`.
