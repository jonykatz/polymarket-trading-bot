import "dotenv/config";

function envBool(v: string | undefined, defaultVal = false): boolean {
  if (v === undefined) return defaultVal;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export const cfg = {
  polymarketRestBase: process.env.POLYMARKET_REST_BASE ?? "https://gamma-api.polymarket.com",
  polymarketDataApiBase: process.env.POLYMARKET_DATA_API_BASE ?? "https://data-api.polymarket.com",
  binanceRestBase: process.env.BINANCE_REST_BASE ?? "https://fapi.binance.com",
  binanceFeaturesEnabled: envBool(process.env.BINANCE_FEATURES_ENABLED, true),
  binanceSnapshotTtlSec: Number(process.env.BINANCE_SNAPSHOT_TTL_SEC ?? 60),
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  openaiBaseUrl: (process.env.OPENAI_BASE_URL ?? "").trim() || "https://api.openai.com/v1",
  openaiModel: (process.env.OPENAI_MODEL ?? "").trim() || "gpt-4o-mini",
  loopSeconds: Number(process.env.LOOP_SECONDS ?? 15),
  maxPositionUsd: Number(process.env.MAX_POSITION_USD ?? 100),
  edgeThreshold: Number(process.env.EDGE_THRESHOLD ?? 0.03),
  confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.8),
  entrySlippage: Number(process.env.ENTRY_SLIPPAGE ?? 0.05),
  entryBookSlippage: Number(process.env.ENTRY_BOOK_SLIPPAGE ?? 0.02),
  entryBookMaxSpread: Number(process.env.ENTRY_BOOK_MAX_SPREAD ?? 0.08),
  exitBookSlippage: Number(process.env.EXIT_BOOK_SLIPPAGE ?? 0.02),
  exitBookSlippageUrgent: Number(process.env.EXIT_BOOK_SLIPPAGE_URGENT ?? 0.05),
  /** Min seconds left in the 5m window before allowing a new live entry. */
  minRemainingSecEntry: Number(process.env.MIN_REMAINING_SEC_ENTRY ?? 60),
  /** Sell when (mark − entry) / (1 − entry) ≥ this (e.g. 0.70 = 70% of max gain). */
  takeProfitPctOfMax: Number(process.env.TAKE_PROFIT_PCT_OF_MAX ?? 0.7),
  /** Sell when mark ≤ entry × (1 − this), e.g. 0.25 = 25% below entry. */
  stopLossPct: Number(process.env.STOP_LOSS_PCT ?? 0.25),
  /** Near expiry: force sell losers only when remainingSec ≤ this (+ loop interval). */
  forceExitSeconds: Number(process.env.FORCE_EXIT_SECONDS ?? 45),
  emaFast: Number(process.env.EMA_FAST ?? 5),
  emaSlow: Number(process.env.EMA_SLOW ?? 13),
  rsiPeriod: Number(process.env.RSI_PERIOD ?? 14),
  whaleMinWinrate: Number(process.env.WHALE_MIN_WINRATE ?? 0.7),
  whaleMinNotional: Number(process.env.WHALE_MIN_NOTIONAL ?? 200),
  walletWinrateApiUrl: process.env.WALLET_WINRATE_API_URL ?? "",
  walletWinrateApiKey: process.env.WALLET_WINRATE_API_KEY ?? "",
  walletWinrateTimeoutMs: Number(process.env.WALLET_WINRATE_TIMEOUT_MS ?? 3000),
  walletWinrateCacheTtlSec: Number(process.env.WALLET_WINRATE_CACHE_TTL_SEC ?? 600),
  clobApiUrl: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
  clobChainId: Number(process.env.CLOB_CHAIN_ID ?? 137),
  clobSignatureType: (process.env.CLOB_SIGNATURE_TYPE ?? "EOA").trim(),
  clobFunderAddress: (process.env.CLOB_FUNDER_ADDRESS ?? "").trim() || undefined,
  clobBuilderCode: (process.env.CLOB_BUILDER_CODE ?? "").trim() || undefined,
  clobUseServerTime: envBool(process.env.CLOB_USE_SERVER_TIME, false),
  privateKey: process.env.PRIVATE_KEY,
  clobApiKey: process.env.CLOB_API_KEY,
  clobSecret: process.env.CLOB_SECRET,
  clobPassphrase: process.env.CLOB_PASS_PHRASE,
  paperMode: envBool(process.env.PAPER_MODE, false),
  webhookUrl: (process.env.WEBHOOK_URL ?? "").trim(),
  liveTradingEnabled:
    Boolean(process.env.PRIVATE_KEY?.trim()) && !envBool(process.env.PAPER_MODE, false),
  closeAfterSeconds: Number(process.env.CLOSE_AFTER_SECONDS ?? 0),
  /** Ms to wait after buy/sell/settle before reading CLOB USDC for fee/PnL snapshots. */
  balanceSettleDelayMs: Number(process.env.BALANCE_SETTLE_DELAY_MS ?? 8000),
  /** Activity reporter: poll Polymarket /activity every N seconds. */
  activityPollSeconds: Number(
    process.env.ACTIVITY_POLL_SECONDS ?? process.env.REPORTER_LOOP_SECONDS ?? 30
  ),
  /** How many latest movements to compare each poll. */
  activityPollLimit: Number(process.env.ACTIVITY_POLL_LIMIT ?? 5),
  /** On cold start, mark current movements as known without POST (avoids duplicates after bulk sync). */
  activityPollSeedOnStart: envBool(process.env.ACTIVITY_POLL_SEED_ON_START, true),
  /** Delay between n8n POSTs (Sheets quota protection). */
  n8nSyncDelayMs: Number(process.env.N8N_SYNC_DELAY_MS ?? 4000)
};
