import "dotenv/config";
import {
  AssetType,
  ClobClient,
  Chain,
  Side,
  OrderType,
  SignatureTypeV2
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const LABELS = [
  ["POLY_PROXY", SignatureTypeV2.POLY_PROXY],
  ["POLY_GNOSIS_SAFE", SignatureTypeV2.POLY_GNOSIS_SAFE],
  ["POLY_1271", SignatureTypeV2.POLY_1271],
  ["EOA", SignatureTypeV2.EOA]
];

function wallet() {
  const raw = process.env.PRIVATE_KEY.trim();
  const pk = raw.startsWith("0x") ? raw : `0x${raw}`;
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: polygon, transport: http() });
}

async function credsFor(signer, signatureType, funderAddress) {
  const l1 = new ClobClient({
    host: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer,
    signatureType,
    funderAddress
  });
  for (const nonce of [0, 1, undefined]) {
    try {
      const d = await l1.deriveApiKey(nonce);
      if (d?.key) return d;
    } catch {}
  }
  for (const nonce of [0, 1, undefined]) {
    try {
      const c = await l1.createApiKey(nonce);
      if (c?.key) return c;
    } catch {}
  }
  throw new Error("no creds");
}

function isOk(res) {
  if (!res) return false;
  if (res.error) return false;
  if (typeof res.status === "number" && res.status >= 400) return false;
  if (res.success === false) return false;
  return Boolean(res.orderID || res.orderIds?.length);
}

async function main() {
  const funder = process.env.CLOB_FUNDER_ADDRESS?.trim();
  const signer = wallet();
  const signerAddr = signer.account.address;
  console.log("signer:", signerAddr);
  console.log("funder:", funder ?? "(none)");

  const pub = new ClobClient({
    host: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
    chain: Chain.POLYGON
  });
  const markets = await pub.getSamplingMarkets();
  let m = markets?.data?.find((x) => /btc-updown-5m/i.test(x.market_slug ?? ""));
  if (!m && markets?.data?.length) m = markets.data[0];
  if (!m) {
    console.error("no market");
    process.exit(1);
  }
  const tokenId =
    m.tokens?.find((t) => /up|yes/i.test(t.outcome ?? ""))?.token_id ?? m.tokens?.[0]?.token_id;
  if (!tokenId) {
    console.error("no yes token");
    process.exit(1);
  }
  console.log("market:", m.market_slug);
  console.log("token:", tokenId);

  for (const [label, sigType] of LABELS) {
    if (label !== "EOA" && !funder) continue;
    try {
      const funderAddress = label === "EOA" ? undefined : funder;
      const creds = await credsFor(signer, sigType, funderAddress);
      const client = new ClobClient({
        host: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
        chain: Chain.POLYGON,
        signer,
        creds,
        signatureType: sigType,
        funderAddress
      });
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const res = await client.createAndPostMarketOrder(
        { tokenID: tokenId, side: Side.BUY, amount: 1, price: 0.5, orderType: OrderType.FOK },
        { tickSize: "0.01" },
        OrderType.FOK
      );
      const ok = isOk(res);
      console.log(
        `\n${label}: balance=${bal.balance} ok=${ok} status=${res.status ?? "-"} orderID=${res.orderID ?? "-"} error=${res.error ?? res.errorMsg ?? "-"}`
      );
      if (ok) {
        console.log("SUCCESS with", label);
        process.exit(0);
      }
    } catch (e) {
      console.log(`\n${label}: threw ${e.message ?? e}`);
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
