import "dotenv/config";
import {
  fetchAccountPositions,
  isBtc5mPosition,
  type ApiPosition
} from "./connectors/accountPositions.js";
import { resolveAccountWallet } from "./connectors/accountActivity.js";
import { getOpenPositions } from "./engine/positionStore.js";
import { cfg } from "./config.js";

type OutputFormat = "table" | "pretty" | "raw";

type CliOptions = {
  wallet?: string;
  sizeThreshold: number;
  btc5mOnly: boolean;
  format: OutputFormat;
  compareLocal: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    sizeThreshold: 0.01,
    btc5mOnly: false,
    format: "table",
    compareLocal: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pretty" || arg === "--json") {
      opts.format = "pretty";
      continue;
    }
    if (arg === "--raw") {
      opts.format = "raw";
      continue;
    }
    if (arg === "--btc5m") {
      opts.btc5mOnly = true;
      continue;
    }
    if (arg === "--compare-local") {
      opts.compareLocal = true;
      continue;
    }
    if (arg === "--wallet" && argv[i + 1]) {
      opts.wallet = argv[++i];
      continue;
    }
    if (arg === "--size-threshold" && argv[i + 1]) {
      opts.sizeThreshold = Number(argv[++i]);
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
  console.log(`Usage: npm run polymarket:positions [-- options]

Spike: GET data-api.polymarket.com/positions for the trading wallet.

Options:
  --wallet <0x...>       Override wallet (default: CLOB_FUNDER_ADDRESS or signer)
  --size-threshold <n>    API min size filter (default 0.01; API default is 1)
  --btc5m                 Only show btc-updown-5m-* positions
  --compare-local         Show .data/open-positions.json next to API rows
  --pretty / --json       Full JSON per position
  --raw                   Print raw API JSON array
  -h, --help              This help

Examples:
  npm run polymarket:positions
  npm run polymarket:positions -- --btc5m --compare-local
  npm run polymarket:positions -- --pretty
`);
}

function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function marketKey(pos: ApiPosition): string {
  return pos.eventSlug || pos.slug || pos.conditionId || "?";
}

function printTable(rows: ApiPosition[]): void {
  if (!rows.length) {
    console.log("(no positions returned)");
    return;
  }

  console.log(
    [
      "slug/eventSlug".padEnd(36),
      "outcome".padEnd(8),
      "size".padStart(8),
      "avgPx".padStart(7),
      "curPx".padStart(7),
      "cashPnl".padStart(9),
      "redeem".padStart(6),
      "asset".padEnd(14)
    ].join(" ")
  );
  console.log("-".repeat(100));

  for (const pos of rows) {
    console.log(
      [
        marketKey(pos).slice(0, 36).padEnd(36),
        (pos.outcome ?? "?").slice(0, 8).padEnd(8),
        (pos.size ?? 0).toFixed(2).padStart(8),
        (pos.avgPrice ?? 0).toFixed(3).padStart(7),
        (pos.curPrice ?? 0).toFixed(3).padStart(7),
        (pos.cashPnl ?? 0).toFixed(2).padStart(9),
        String(pos.redeemable ?? false).padStart(6),
        shortAddr(pos.asset ?? "?").padEnd(14)
      ].join(" ")
    );
  }
}

function printLocalCompare(apiRows: ApiPosition[]): void {
  const local = getOpenPositions();
  console.log("\n--- Local .data/open-positions.json ---");
  if (!local.length) {
    console.log("(empty)");
  } else {
    for (const p of local) {
      console.log(
        `  ${p.marketId} | ${p.side} | shares=${p.sizeShares} | entry=${p.entryPriceReal?.toFixed(3) ?? p.entryPrice?.toFixed(3) ?? "?"} | token=${shortAddr(p.tokenId)}`
      );
    }
  }

  console.log("\n--- Quick diff (btc-updown-5m) ---");
  const apiBtc = apiRows.filter(isBtc5mPosition);
  const localSlugs = new Set(local.map((p) => p.marketId));
  const apiSlugs = new Set(apiBtc.map((p) => marketKey(p)));

  for (const slug of localSlugs) {
    if (!apiSlugs.has(slug) && slug.includes("btc-updown-5m")) {
      console.log(`  LOCAL ONLY (ghost?): ${slug}`);
    }
  }
  for (const pos of apiBtc) {
    const key = marketKey(pos);
    if (!localSlugs.has(key)) {
      console.log(`  API ONLY (orphan?): ${key} size=${pos.size}`);
    }
  }
  if (localSlugs.size === 0 && apiBtc.length === 0) {
    console.log("  (both empty for btc 5m)");
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const wallet = resolveAccountWallet(opts.wallet);

  console.log("Polymarket Data API — /positions spike\n");
  console.log(`Base:   ${cfg.polymarketDataApiBase}`);
  console.log(`Wallet: ${wallet}`);
  console.log(`sizeThreshold: ${opts.sizeThreshold}`);
  if (opts.btc5mOnly) console.log("Filter: btc-updown-5m only");

  const rows = await fetchAccountPositions({
    wallet: opts.wallet,
    sizeThreshold: opts.sizeThreshold
  });

  let filtered = opts.btc5mOnly ? rows.filter(isBtc5mPosition) : rows;
  console.log(`\nReturned: ${rows.length} position(s)${opts.btc5mOnly ? `, ${filtered.length} after --btc5m` : ""}\n`);

  if (opts.format === "raw") {
    console.log(JSON.stringify(filtered, null, 2));
  } else if (opts.format === "pretty") {
    console.log(JSON.stringify(filtered, null, 2));
  } else {
    printTable(filtered);
  }

  if (opts.compareLocal) {
    printLocalCompare(rows);
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(`polymarket:positions failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
