import "dotenv/config";
import { cfg } from "./config.js";
import { getAccountBalance } from "./connectors/orderExecution.js";
import { validateClobAccountEnv } from "./envCheck.js";

async function main() {
  validateClobAccountEnv();

  console.log("Polymarket CLOB account\n");
  console.log(`Host:  ${cfg.clobApiUrl}`);
  console.log(`Chain: ${cfg.clobChainId}`);

  const account = await getAccountBalance();

  console.log(`\nSigner:          ${account.signerAddress}`);
  if (account.funderAddress) {
    console.log(`Funder (USDC):   ${account.funderAddress}`);
  }
  console.log(`Signature type:  ${account.signatureType}`);
  if (account.suggestedSignatureType) {
    console.log(
      `\nTip: balance detected with ${account.suggestedSignatureType}. ` +
        `Set CLOB_SIGNATURE_TYPE=${account.suggestedSignatureType} in .env for live trading.`
    );
  }
  console.log(`\nUSDC balance:    $${account.balanceUsdc.toFixed(2)}`);
  console.log(`USDC allowance:  $${account.allowanceUsdc.toFixed(2)}`);
  console.log(`Available to trade: $${account.availableUsdc.toFixed(2)}`);
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Balance check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
