import "dotenv/config";
import { cfg } from "./config.js";
import { verifyBinanceReadiness } from "./connectors/binance.js";

async function main() {
  console.log(`Binance REST base: ${cfg.binanceRestBase}`);
  console.log("(Futures: fapi.binance.com — Spot: api.binance.com)\n");

  const probe = await verifyBinanceReadiness();
  if (!probe.ok || !probe.snapshot) {
    console.error("Binance readiness failed:", probe.error ?? "unknown error");
    process.exit(1);
  }

  const s = probe.snapshot;
  console.log(`Symbol:    ${s.symbol}`);
  console.log(`Price:     ${s.price.toFixed(2)} USDT`);
  console.log(`Return 1m: ${(s.return1m * 100).toFixed(4)}%`);
  console.log(`Return 5m: ${(s.return5m * 100).toFixed(4)}%`);
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
