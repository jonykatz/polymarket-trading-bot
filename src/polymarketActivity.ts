import "dotenv/config";
import {
  fetchAccountMovements,
  resolveAccountWallet,
  toSheetMovement,
  type AccountMovement,
  type AccountMovementSheet
} from "./connectors/accountActivity.js";
import { validateClobAccountEnv } from "./envCheck.js";

type OutputFormat = "table" | "pretty" | "compact";

type CliOptions = {
  wallet?: string;
  limit?: number;
  fetchAll: boolean;
  sheet: boolean;
  type?: string;
  since?: string;
  until?: string;
  format: OutputFormat;
  sortDirection: "ASC" | "DESC";
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { format: "table", fetchAll: false, sheet: false, sortDirection: "DESC" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--table") {
      opts.format = "table";
      continue;
    }
    if (arg === "--pretty" || arg === "--json") {
      opts.format = "pretty";
      continue;
    }
    if (arg === "--compact") {
      opts.format = "compact";
      continue;
    }
    if (arg === "--wallet" && argv[i + 1]) {
      opts.wallet = argv[++i];
      continue;
    }
    if (arg === "--all") {
      opts.fetchAll = true;
      continue;
    }
    if (arg === "--sheet") {
      opts.sheet = true;
      continue;
    }
    if (arg === "--asc") {
      opts.sortDirection = "ASC";
      continue;
    }
    if (arg === "--desc") {
      opts.sortDirection = "DESC";
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      opts.limit = Number(argv[++i]);
      continue;
    }
    if (arg === "--type" && argv[i + 1]) {
      opts.type = argv[++i];
      continue;
    }
    if (arg === "--since" && argv[i + 1]) {
      opts.since = argv[++i];
      continue;
    }
    if (arg === "--until" && argv[i + 1]) {
      opts.until = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`Usage: npm run polymarket:activity [-- options]

Fetches Polymarket account movements (TRADE, REDEEM, MERGE, SPLIT, …).

Output (default: --table):
  --table          Human-readable table for the terminal (default)
  --pretty         Indented JSON
  --compact        One-line JSON (for pipes / scripts)

Options:
  --wallet 0x...   Override wallet (default: CLOB_FUNDER_ADDRESS or signer)
  --all            Full history — paginate until API has no more rows
  --limit N        Max rows (default: 10,000; ignored when --all)
  --sheet          Add movementId, tradeLeg, feeUsd (for n8n / Google Sheets)
  --asc            Oldest first (default: --desc, newest first)
  --desc           Newest first
  --type TRADE     Filter by activity type
  --since YYYY-MM-DD   Start date (UTC)
  --until YYYY-MM-DD   End date (UTC, inclusive)

Examples:
  npm run polymarket:activity
  npm run polymarket:activity:all
  npm run polymarket:activity -- --all --sheet --pretty
  npm run polymarket:activity -- --type TRADE --limit 20
  npm run polymarket:activity -- --since 2026-06-10 --pretty
`);
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

function formatCash(cashFlowUsd: number): string {
  const sign = cashFlowUsd >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(cashFlowUsd).toFixed(2)}`;
}

function printTable(wallet: string, movements: AccountMovement[]): void {
  console.log(`\nPolymarket account activity`);
  console.log(`Wallet:    ${wallet}`);
  console.log(`Movements: ${movements.length}\n`);

  if (movements.length === 0) {
    console.log("(no movements)\n");
    return;
  }

  const header = [
    padEnd("TIME (UTC)", 20),
    padEnd("TYPE", 8),
    padEnd("SIDE", 5),
    padEnd("CASH", 9),
    "MARKET"
  ].join("  ");
  console.log(header);
  console.log("-".repeat(Math.min(100, header.length + 40)));

  for (const m of movements) {
    const time = m.timestamp.replace("T", " ").slice(0, 19);
    const side = m.side ?? "—";
    const title = m.marketTitle || m.marketSlug || "(unknown)";
    console.log(
      [
        padEnd(time, 20),
        padEnd(m.type, 8),
        padEnd(side, 5),
        padEnd(formatCash(m.cashFlowUsd), 9),
        title
      ].join("  ")
    );
  }

  const net = movements.reduce((sum, m) => sum + m.cashFlowUsd, 0);
  console.log(`\nNet cash flow (shown rows): ${formatCash(net)}\n`);
}

function dateToStartSec(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${isoDate} (use YYYY-MM-DD)`);
  }
  return Math.floor(d.getTime() / 1000);
}

function dateToEndSec(isoDate: string): number {
  const d = new Date(`${isoDate}T23:59:59.999Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${isoDate} (use YYYY-MM-DD)`);
  }
  return Math.floor(d.getTime() / 1000);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  validateClobAccountEnv();

  const wallet = resolveAccountWallet(opts.wallet);
  const movements = await fetchAccountMovements({
    wallet: opts.wallet,
    limit: opts.fetchAll ? undefined : opts.limit,
    fetchAll: opts.fetchAll,
    type: opts.type,
    startSec: opts.since ? dateToStartSec(opts.since) : undefined,
    endSec: opts.until ? dateToEndSec(opts.until) : undefined,
    sortDirection: opts.sortDirection
  });

  const rows: AccountMovement[] | AccountMovementSheet[] = opts.sheet
    ? movements.map(toSheetMovement)
    : movements;

  if (opts.format === "table") {
    printTable(wallet, movements);
    if (opts.sheet) {
      console.error("(table view omits sheet fields; use --pretty or --compact with --sheet)");
    }
    return;
  }

  const payload = {
    wallet,
    count: rows.length,
    fetchAll: opts.fetchAll,
    sheet: opts.sheet,
    movements: rows
  };

  process.stdout.write(
    opts.format === "pretty"
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${JSON.stringify(payload)}\n`
  );
}

main().catch((error: unknown) => {
  const err = error as Error;
  console.error(`polymarket:activity failed: ${err.message ?? String(error)}`);
  process.exit(1);
});
