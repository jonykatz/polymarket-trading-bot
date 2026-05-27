# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- Added: `PAPER_MODE` and `WEBHOOK_URL` in `src/config.ts`; `src/connectors/orderExecution.ts` simulates orders without CLOB calls; `src/engine/paperTrader.ts` tracks PnL on settlement and POSTs closed trades to a webhook.
- Fixed: `src/main.ts` paper flow now calls `onPrediction()` for SKIP/OPEN; canonical `marketMeta.slug` avoids duplicate opens when tick `marketId` differs from stored position key.
