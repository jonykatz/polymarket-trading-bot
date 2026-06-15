import "dotenv/config";
import {
  fetchAllAccountMovements,
  toSheetMovement
} from "./connectors/accountActivity.js";
import { cfg } from "./config.js";
import { validateClobAccountEnv } from "./envCheck.js";
import {
  defaultPostDelayMs,
  markMovementSynced,
  postMovement,
  sleep,
  toN8nPayload
} from "./engine/n8nMovementSync.js";

type SyncOpts = {
  dryRun: boolean;
  limit?: number;
  skip: number;
  delayMs: number;
};

function parseArgs(argv: string[]): SyncOpts {
  const defaultDelay = defaultPostDelayMs();
  const opts: SyncOpts = { dryRun: false, skip: 0, delayMs: defaultDelay };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true;
    if (argv[i] === "--limit" && argv[i + 1]) opts.limit = Number(argv[++i]);
    if (argv[i] === "--skip" && argv[i + 1]) opts.skip = Number(argv[++i]);
    if (argv[i] === "--delay-ms" && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: npm run polymarket:sync-n8n [-- options]

Posts full wallet activity history to WEBHOOK_URL (oldest → newest).

Options:
  --dry-run          Fetch and print count only; do not POST
  --limit N          Post only first N movements (after skip)
  --skip N           Skip first N movements (resume after partial sync)
  --delay-ms N       Pause between POSTs (default: ${defaultDelay} or N8N_SYNC_DELAY_MS)

Env:
  N8N_SYNC_DELAY_MS  Default delay between webhook POSTs (ms)

Tip: Google Sheets quota — use --delay-ms 5000 or higher for bulk historic sync.
`);
      process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  validateClobAccountEnv();

  const url = cfg.webhookUrl.trim();
  if (!url && !opts.dryRun) {
    throw new Error("WEBHOOK_URL is required (set in .env)");
  }

  const raw = await fetchAllAccountMovements({ sortDirection: "ASC" });
  const movements = raw.map(toSheetMovement);
  const sliced = movements.slice(opts.skip);
  const batch = opts.limit != null ? sliced.slice(0, opts.limit) : sliced;

  const types = [...new Set(batch.map((m) => m.type))].sort();
  const etaMin = Math.ceil((batch.length * opts.delayMs) / 60_000);
  console.error(
    `Fetched ${movements.length} movement(s) [${types.join(", ")}]; posting ${batch.length} ` +
      `(skip=${opts.skip}, delay=${opts.delayMs}ms, ~${etaMin} min)…`
  );

  if (opts.dryRun) {
    console.log(JSON.stringify({ count: batch.length, types, sample: toN8nPayload(batch[0]) }, null, 2));
    return;
  }

  let ok = 0;
  for (const movement of batch) {
    const payload = toN8nPayload(movement, undefined, batch);
    try {
      await postMovement(url, payload);
      markMovementSynced(payload.movementId);
      ok++;
      console.error(`  [${ok}/${batch.length}] OK ${payload.tradeLeg} ${payload.type} ${payload.marketSlug}`);
      if (opts.delayMs > 0 && ok < batch.length) await sleep(opts.delayMs);
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`  FAILED ${payload.movementId}: ${err.message ?? String(error)}`);
      throw new Error(`Sync stopped after ${ok} successful POST(s)`);
    }
  }

  console.error(`Done — ${ok} movement(s) posted to n8n.`);
}

main().catch((error: unknown) => {
  const err = error as Error;
  console.error(`polymarket:sync-n8n failed: ${err.message ?? String(error)}`);
  process.exit(1);
});
