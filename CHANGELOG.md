# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- Added: `PAPER_MODE` and `WEBHOOK_URL` in `src/config.ts`; `src/connectors/orderExecution.ts` simulates orders without CLOB calls; `src/engine/paperTrader.ts` tracks PnL on settlement and POSTs closed trades to a webhook.
- Fixed: `src/main.ts` paper flow now calls `onPrediction()` for SKIP/OPEN; canonical `marketMeta.slug` avoids duplicate opens when tick `marketId` differs from stored position key.
- Fixed: `src/main.ts` paper entries use `EDGE_THRESHOLD` via `paperTrader.onPrediction()` instead of `CONFIDENCE_THRESHOLD`; `src/engine/paperTrader.ts` settles in the last `LOOP_SECONDS` window so webhooks fire when the loop skips `remainingSec === 0`.
