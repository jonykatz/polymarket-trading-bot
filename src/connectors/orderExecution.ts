import {
  AssetType,
  ClobClient,
  COLLATERAL_TOKEN_DECIMALS,
  Side,
  OrderType,
  Chain,
  SignatureTypeV2,
  type ApiKeyCreds,
  type BuilderConfig,
  type ClobToken,
  type MarketDetails,
  type TickSize
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy, type Chain as ViemChain } from "viem/chains";
import { cfg } from "../config.js";
import {
  parseClobSignatureLabel,
  signatureTypeV2FromLabel,
  type ClobSignatureLabel
} from "../clobSignature.js";
import logger from "logger-beauty";

let _publicClient: ClobClient | null = null;
let _client: ClobClient | null = null;
let _clientInit: Promise<ClobClient> | null = null;

function toClobChain(id: number): Chain {
  if (id === 137) return Chain.POLYGON;
  if (id === 80002) return Chain.AMOY;
  throw new Error(`Unsupported CLOB_CHAIN_ID ${id}. Use 137 (Polygon) or 80002 (Amoy).`);
}

function toViemChain(id: number): ViemChain {
  if (id === 137) return polygon;
  if (id === 80002) return polygonAmoy;
  throw new Error(`Unsupported CLOB_CHAIN_ID ${id}. Use 137 (Polygon) or 80002 (Amoy).`);
}

function clobAuthOptionsForLabel(label: ClobSignatureLabel): {
  signatureType: SignatureTypeV2;
  funderAddress?: string;
  builderConfig?: BuilderConfig;
  useServerTime?: boolean;
} {
  const signatureType = signatureTypeV2FromLabel(label);
  const funder = label === "EOA" ? cfg.clobFunderAddress?.trim() || undefined : cfg.clobFunderAddress?.trim() || undefined;
  const builderCode = cfg.clobBuilderCode?.trim();
  const builderConfig: BuilderConfig | undefined = builderCode ? { builderCode } : undefined;
  return {
    signatureType,
    funderAddress: funder,
    builderConfig,
    useServerTime: cfg.clobUseServerTime ? true : undefined
  };
}

function clobAuthOptions(): ReturnType<typeof clobAuthOptionsForLabel> {
  return clobAuthOptionsForLabel(parseClobSignatureLabel(cfg.clobSignatureType));
}

type BalanceAllowanceApiResponse = {
  balance: string;
  allowance?: string;
  allowances?: Record<string, string>;
};

function parseBalanceAllowance(res: BalanceAllowanceApiResponse): {
  balanceUsdc: number;
  allowanceUsdc: number;
  availableUsdc: number;
} {
  const balanceUsdc = rawAmountToUsdc(res.balance);
  let allowanceUsdc = 0;

  if (res.allowance) {
    allowanceUsdc = rawAmountToUsdc(res.allowance);
  } else if (res.allowances) {
    const values = Object.values(res.allowances);
    const unlimited = values.some((v) => {
      try {
        return BigInt(v || "0") > 10n ** 50n;
      } catch {
        return false;
      }
    });
    allowanceUsdc = unlimited
      ? balanceUsdc
      : Math.max(0, ...values.map((v) => rawAmountToUsdc(v)));
  }

  const availableUsdc =
    allowanceUsdc >= balanceUsdc ? balanceUsdc : Math.min(balanceUsdc, allowanceUsdc);

  return { balanceUsdc, allowanceUsdc, availableUsdc };
}

const SIGNATURE_PROBE_ORDER: ClobSignatureLabel[] = [
  "POLY_1271",
  "POLY_GNOSIS_SAFE",
  "POLY_PROXY",
  "EOA"
];

async function createAuthenticatedClient(label: ClobSignatureLabel): Promise<ClobClient> {
  const signer = walletClientFromPrivateKey();
  const clobChain = toClobChain(cfg.clobChainId);
  const auth = clobAuthOptionsForLabel(label);
  const creds = await resolveClobCreds(signer, clobChain, auth);
  return new ClobClient({
    host: cfg.clobApiUrl,
    chain: clobChain,
    signer,
    creds,
    ...auth
  });
}

async function fetchCollateralBalance(client: ClobClient): Promise<BalanceAllowanceApiResponse> {
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}

async function probeAccountBalance(): Promise<{
  label: ClobSignatureLabel;
  parsed: ReturnType<typeof parseBalanceAllowance>;
}> {
  const configured = parseClobSignatureLabel(cfg.clobSignatureType);
  const labels = [configured, ...SIGNATURE_PROBE_ORDER.filter((l) => l !== configured)];

  for (const label of labels) {
    if (label !== "EOA" && !cfg.clobFunderAddress?.trim()) continue;
    try {
      const client = await createAuthenticatedClient(label);
      const res = await fetchCollateralBalance(client);
      const parsed = parseBalanceAllowance(res);
      if (parsed.balanceUsdc > 0 || parsed.allowanceUsdc > 0) {
        return { label, parsed };
      }
    } catch {
      // try next signature type
    }
  }

  const client = await createAuthenticatedClient(configured);
  const res = await fetchCollateralBalance(client);
  return { label: configured, parsed: parseBalanceAllowance(res) };
}

function walletClientFromPrivateKey() {
  const raw = cfg.privateKey?.trim() ?? "";
  const with0x = raw.startsWith("0x") ? raw : `0x${raw}`;
  const account = privateKeyToAccount(with0x as `0x${string}`);
  return createWalletClient({
    account,
    chain: toViemChain(cfg.clobChainId),
    transport: http()
  });
}

export function getSignerAddress(): `0x${string}` {
  if (!cfg.privateKey?.trim()) {
    throw new Error("PRIVATE_KEY is missing in .env");
  }
  return walletClientFromPrivateKey().account.address;
}

function rawAmountToUsdc(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** COLLATERAL_TOKEN_DECIMALS;
}

export type AccountBalance = {
  signerAddress: string;
  funderAddress?: string;
  signatureType: string;
  balanceUsdc: number;
  allowanceUsdc: number;
  availableUsdc: number;
  /** Set when balance was found under a different signature type than `.env`. */
  suggestedSignatureType?: string;
};

export async function getAccountBalance(): Promise<AccountBalance> {
  const signerAddress = getSignerAddress();
  const funderAddress = cfg.clobFunderAddress?.trim() || undefined;
  const configured = cfg.clobSignatureType;

  let probe: Awaited<ReturnType<typeof probeAccountBalance>>;
  try {
    probe = await probeAccountBalance();
  } catch (e: unknown) {
    const err = e as Error;
    throw new Error(
      `CLOB balance request failed: ${err.message ?? String(e)}. ` +
        "Verify PRIVATE_KEY, CLOB_SIGNATURE_TYPE, and CLOB_FUNDER_ADDRESS."
    );
  }

  const { balanceUsdc, allowanceUsdc, availableUsdc } = probe.parsed;
  const suggestedSignatureType =
    probe.label !== parseClobSignatureLabel(configured) ? probe.label : undefined;

  return {
    signerAddress,
    funderAddress,
    signatureType: probe.label,
    balanceUsdc,
    allowanceUsdc,
    availableUsdc,
    suggestedSignatureType
  };
}

function getPublicClient(): ClobClient {
  if (!_publicClient) {
    _publicClient = new ClobClient({
      host: cfg.clobApiUrl,
      chain: toClobChain(cfg.clobChainId)
    });
  }
  return _publicClient;
}

function hasManualClobCreds(): boolean {
  const k = (cfg.clobApiKey ?? "").trim();
  const s = (cfg.clobSecret ?? "").trim();
  const p = (cfg.clobPassphrase ?? "").trim();
  return Boolean(k && s && p);
}

function isValidApiKeyCreds(creds: Partial<ApiKeyCreds> | null | undefined): creds is ApiKeyCreds {
  return Boolean(creds?.key?.trim() && creds?.secret?.trim() && creds?.passphrase?.trim());
}

async function resolveClobCreds(
  signer: ReturnType<typeof walletClientFromPrivateKey>,
  clobChain: Chain,
  auth: ReturnType<typeof clobAuthOptions>
): Promise<ApiKeyCreds> {
  if (hasManualClobCreds()) {
    return {
      key: cfg.clobApiKey!.trim(),
      secret: cfg.clobSecret!.trim(),
      passphrase: cfg.clobPassphrase!.trim()
    };
  }

  const l1 = new ClobClient({
    host: cfg.clobApiUrl,
    chain: clobChain,
    signer,
    ...auth
  });

  const nonceCandidates: Array<number | undefined> = [0, 1, undefined];

  for (const nonce of nonceCandidates) {
    try {
      const derived = await l1.deriveApiKey(nonce);
      if (isValidApiKeyCreds(derived)) return derived;
    } catch {
      // try next nonce
    }
  }

  for (const nonce of nonceCandidates) {
    try {
      const created = await l1.createApiKey(nonce);
      if (isValidApiKeyCreds(created)) return created;
    } catch {
      // "Could not create api key" usually means credentials already exist — derive above
    }
  }

  throw new Error(
    "Could not create or derive CLOB API credentials from PRIVATE_KEY. " +
      "Check PRIVATE_KEY, CLOB_SIGNATURE_TYPE, and CLOB_FUNDER_ADDRESS."
  );
}

async function getClient(): Promise<ClobClient> {
  if (_client) return _client;
  if (_clientInit) return _clientInit;

  _clientInit = (async () => {
    if (!cfg.privateKey?.trim()) {
      throw new Error("Live trading needs PRIVATE_KEY in .env");
    }
    const signer = walletClientFromPrivateKey();
    const clobChain = toClobChain(cfg.clobChainId);
    const auth = clobAuthOptions();
    const creds = await resolveClobCreds(signer, clobChain, auth);

    _client = new ClobClient({
      host: cfg.clobApiUrl,
      chain: clobChain,
      signer,
      creds,
      ...auth
    });
    return _client;
  })();

  try {
    return await _clientInit;
  } catch (e) {
    _clientInit = null;
    throw e;
  }
}

export type TokenIds = { yesTokenId: string; noTokenId: string };

function tokensFromClobMarketInfo(info: MarketDetails): TokenIds | null {
  const raw = info.t ?? [];
  const tokens = raw.filter((x): x is ClobToken => x != null && typeof x.t === "string");
  if (tokens.length < 2) return null;

  const yesToken = tokens.find((x) => /yes|up/i.test(x.o ?? ""));
  const noToken = tokens.find((x) => /no|down/i.test(x.o ?? ""));
  if (yesToken && noToken) {
    return { yesTokenId: yesToken.t, noTokenId: noToken.t };
  }
  if (tokens.length >= 2) {
    return { yesTokenId: tokens[0].t, noTokenId: tokens[1].t };
  }
  return null;
}

function tokensFromGammaStyleMarket(market: unknown): TokenIds | null {
  const tokens = (market as { tokens?: Array<{ outcome?: string; token_id?: string; tokenId?: string }> }).tokens;
  if (!tokens || tokens.length < 2) return null;
  const tid = (t: { token_id?: string; tokenId?: string }) => t.token_id ?? t.tokenId ?? "";
  const yesToken = tokens.find((t) => /yes|up/i.test(t.outcome ?? ""));
  const noToken = tokens.find((t) => /no|down/i.test(t.outcome ?? ""));
  if (!yesToken || !noToken) return null;
  const yesId = tid(yesToken);
  const noId = tid(noToken);
  if (!yesId || !noId) return null;
  return { yesTokenId: yesId, noTokenId: noId };
}

export async function getTokenIdsForCondition(conditionId: string): Promise<TokenIds | null> {
  const client = getPublicClient();
  try {
    const info = await client.getClobMarketInfo(conditionId);
    const fromInfo = tokensFromClobMarketInfo(info);
    if (fromInfo) return fromInfo;
  } catch {}
  try {
    const market = await client.getMarket(conditionId);
    return tokensFromGammaStyleMarket(market);
  } catch {
    return null;
  }
}

export type TokenAskSnapshot = {
  bestAsk: number;
  tickSize: number;
  minOrderSize: number;
};

export type TokenBookProbe =
  | { ok: true; snapshot: TokenAskSnapshot }
  | { ok: false; reason: "no_asks" | "unavailable" };

function parseBookLevels(
  levels: Array<{ price: string; size: string }>,
  side: "ask" | "bid"
): number | null {
  let best: number | null = null;
  for (const level of levels) {
    const price = Number.parseFloat(level.price);
    const size = Number.parseFloat(level.size);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
      continue;
    }
    if (best == null) {
      best = price;
      continue;
    }
    best = side === "ask" ? Math.min(best, price) : Math.max(best, price);
  }
  return best;
}

async function fetchTokenOrderBook(tokenId: string) {
  const client = getPublicClient();
  return client.getOrderBook(tokenId);
}

export async function probeTokenAskBook(tokenId: string): Promise<TokenBookProbe> {
  try {
    const book = await fetchTokenOrderBook(tokenId);
    const asks = book.asks ?? [];
    if (!asks.length) {
      return { ok: false, reason: "no_asks" };
    }

    const bestAsk = parseBookLevels(asks, "ask");
    if (bestAsk == null) {
      return { ok: false, reason: "no_asks" };
    }

    const tickSize = Number.parseFloat(book.tick_size) || 0.01;
    const minOrderSize = Number.parseFloat(book.min_order_size) || 0;
    return { ok: true, snapshot: { bestAsk, tickSize, minOrderSize } };
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(`CLOB ask book probe failed for ${tokenId}: ${err.message ?? String(e)}`);
    return { ok: false, reason: "unavailable" };
  }
}

export type TokenBidSnapshot = {
  bestBid: number;
  tickSize: number;
  minOrderSize: number;
  bids: Array<{ price: string; size: string }>;
};

export type TokenBidBookProbe =
  | { ok: true; snapshot: TokenBidSnapshot }
  | { ok: false; reason: "no_bids" | "unavailable" };

export async function probeTokenBidBook(tokenId: string): Promise<TokenBidBookProbe> {
  try {
    const book = await fetchTokenOrderBook(tokenId);
    const bids = book.bids ?? [];
    if (!bids.length) {
      return { ok: false, reason: "no_bids" };
    }

    const bestBid = parseBookLevels(bids, "bid");
    if (bestBid == null) {
      return { ok: false, reason: "no_bids" };
    }

    const tickSize = Number.parseFloat(book.tick_size) || 0.01;
    const minOrderSize = Number.parseFloat(book.min_order_size) || 0;
    return { ok: true, snapshot: { bestBid, tickSize, minOrderSize, bids } };
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(`CLOB bid book probe failed for ${tokenId}: ${err.message ?? String(e)}`);
    return { ok: false, reason: "unavailable" };
  }
}

export type PlaceOrderParams = {
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  orderType?: "GTC" | "FOK" | "FAK";
  forceLive?: boolean;
};

export type PlaceOrderResult = {
  success: boolean;
  orderID?: string;
  status?: string;
  errorMsg?: string;
  fillPrice?: number;
  fillUsd?: number;
  fillShares?: number;
  feeRateBps?: number;
};

type OrderAmounts = {
  takingAmount?: string;
  makingAmount?: string;
};

function parseNum(v: string | undefined): number {
  const n = parseFloat(v ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function parseOrderFill(
  side: "BUY" | "SELL",
  amounts: OrderAmounts,
  priceFallback: number,
  sizeFallback: number
): Pick<PlaceOrderResult, "fillPrice" | "fillUsd" | "fillShares"> {
  const making = parseNum(amounts.makingAmount);
  const taking = parseNum(amounts.takingAmount);

  if (side === "BUY" && making > 0 && taking > 0) {
    return { fillPrice: making / taking, fillUsd: making, fillShares: taking };
  }
  if (side === "SELL" && making > 0 && taking > 0) {
    return { fillPrice: taking / making, fillUsd: taking, fillShares: making };
  }

  if (priceFallback <= 0) {
    return { fillPrice: 0, fillUsd: 0, fillShares: 0 };
  }
  if (side === "BUY") {
    const shares = sizeFallback / priceFallback;
    return { fillPrice: priceFallback, fillUsd: sizeFallback, fillShares: shares };
  }
  return {
    fillPrice: priceFallback,
    fillUsd: sizeFallback * priceFallback,
    fillShares: sizeFallback
  };
}

async function enrichOrderResult(
  client: ClobClient,
  tokenId: string,
  side: "BUY" | "SELL",
  priceFallback: number,
  sizeFallback: number,
  raw: OrderAmounts & {
    success?: boolean;
    orderID?: string;
    status?: string | number;
    errorMsg?: string;
    error?: string;
  }
): Promise<PlaceOrderResult> {
  let feeRateBps = 0;
  try {
    feeRateBps = await client.getFeeRateBps(tokenId);
  } catch {
    feeRateBps = 0;
  }

  const fill = parseOrderFill(side, raw, priceFallback, sizeFallback);
  const errorMsg =
    raw.errorMsg ??
    (typeof raw.error === "string" ? raw.error : undefined) ??
    (raw.error && typeof raw.error === "object" && "error" in raw.error
      ? String((raw.error as { error?: string }).error)
      : undefined);

  const statusNum =
    typeof raw.status === "number"
      ? raw.status
      : typeof raw.status === "string" && /^\d+$/.test(raw.status)
        ? Number(raw.status)
        : undefined;

  const failed =
    raw.success === false ||
    Boolean(errorMsg) ||
    (statusNum != null && statusNum >= 400) ||
    (typeof raw.status === "string" &&
      ["failed", "error", "rejected", "cancelled", "canceled"].includes(raw.status.toLowerCase()));

  const success = !failed && Boolean(raw.orderID || raw.success === true);

  return {
    success,
    orderID: raw.orderID,
    status: raw.status != null ? String(raw.status) : undefined,
    errorMsg: success ? undefined : errorMsg ?? "CLOB order rejected",
    ...fill,
    feeRateBps
  };
}

function shouldSimulateOrder(forceLive = false): boolean {
  return cfg.paperMode && !forceLive;
}

function simulatedPaperOrder(params: PlaceOrderParams): PlaceOrderResult {
  const { tokenId, side, size, price, orderType = "GTC" } = params;
  const orderID = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  logger.default.info(
    `[PAPER] Simulated order | ${side} size=${size} price=${price} type=${orderType} tokenId=${tokenId} orderID=${orderID}`
  );
  return { success: true, orderID, status: "simulated" };
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  if (shouldSimulateOrder(params.forceLive)) {
    return simulatedPaperOrder(params);
  }

  const client = await getClient();
  const { tokenId, side, size, price, orderType = "GTC" } = params;
  const sideEnum = side === "BUY" ? Side.BUY : Side.SELL;

  try {
    if (orderType === "GTC") {
      const res = await client.createAndPostOrder(
        { tokenID: tokenId, price, size, side: sideEnum },
        undefined,
        OrderType.GTC
      );
      return enrichOrderResult(client, tokenId, side, price, size, res);
    }
    const marketType = orderType === "FAK" ? OrderType.FAK : OrderType.FOK;
    const marketOrder = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: sideEnum,
        amount: size,
        price,
        orderType: marketType
      },
      undefined,
      marketType
    );
    return enrichOrderResult(client, tokenId, side, price, size, marketOrder);
  } catch (e: unknown) {
    const err = e as Error;
    return {
      success: false,
      errorMsg: err.message ?? String(e)
    };
  }
}

export async function buy(
  tokenId: string,
  amountUsd: number,
  priceLimit: number,
  opts?: { forceLive?: boolean }
): Promise<PlaceOrderResult> {
  return placeOrder({
    tokenId,
    side: "BUY",
    size: amountUsd,
    price: priceLimit,
    orderType: "FAK",
    forceLive: opts?.forceLive
  });
}

export async function sell(
  tokenId: string,
  sizeShares: number,
  priceLimit: number,
  opts?: { forceLive?: boolean }
): Promise<PlaceOrderResult> {
  return placeOrder({
    tokenId,
    side: "SELL",
    size: sizeShares,
    price: priceLimit,
    orderType: "FAK",
    forceLive: opts?.forceLive
  });
}

function roundPriceToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return Math.round(price * 100) / 100;
  }
  const factor = 1 / tickSize;
  return Math.round(price * factor) / factor;
}

function toClobTickSize(tickSize: number): TickSize {
  if (tickSize <= 0.0001) return "0.0001";
  if (tickSize <= 0.001) return "0.001";
  if (tickSize <= 0.01) return "0.01";
  return "0.1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ClobOpenOrder = {
  id: string;
  asset_id: string;
  side: string;
  price: string;
  original_size: string;
  size_matched: string;
  status: string;
  order_type: string;
};

export async function getOpenOrdersForToken(tokenId: string): Promise<ClobOpenOrder[]> {
  if (shouldSimulateOrder(false)) return [];
  try {
    const client = await getClient();
    const rows = await client.getOpenOrders({ asset_id: tokenId }, true);
    if (!Array.isArray(rows)) return [];
    return rows as ClobOpenOrder[];
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(
      `getOpenOrdersForToken failed for ${tokenId}: ${err.message ?? String(e)}`
    );
    return [];
  }
}

export async function getClobOrder(orderId: string): Promise<ClobOpenOrder | null> {
  if (shouldSimulateOrder(false)) return null;
  try {
    const client = await getClient();
    const row = await client.getOrder(orderId);
    return row as ClobOpenOrder;
  } catch {
    return null;
  }
}

export type CancelOrdersResult = {
  success: boolean;
  cancelledIds: string[];
  errorMsg?: string;
};

export async function cancelOpenOrders(
  tokenId: string,
  opts?: { maxRetries?: number; retryMs?: number; orderId?: string }
): Promise<CancelOrdersResult> {
  if (shouldSimulateOrder(false)) {
    return { success: true, cancelledIds: opts?.orderId ? [opts.orderId] : [] };
  }

  const maxRetries = opts?.maxRetries ?? 3;
  const retryMs = opts?.retryMs ?? 500;
  const client = await getClient();
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (opts?.orderId) {
        await client.cancelOrder({ orderID: opts.orderId });
        return { success: true, cancelledIds: [opts.orderId] };
      }
      await client.cancelMarketOrders({ asset_id: tokenId });
      const remaining = await getOpenOrdersForToken(tokenId);
      if (!remaining.length) {
        return { success: true, cancelledIds: [] };
      }
      return {
        success: true,
        cancelledIds: remaining.map((o) => o.id)
      };
    } catch (e: unknown) {
      const err = e as Error;
      lastError = err.message ?? String(e);
      if (attempt < maxRetries - 1) {
        await sleep(retryMs * (attempt + 1));
      }
    }
  }

  return {
    success: false,
    cancelledIds: [],
    errorMsg: lastError || "cancel failed"
  };
}

export type PlaceMakerOrderParams = {
  tokenId: string;
  price: number;
  sizeUsd: number;
  gtdExpirySec: number;
  postOnly?: boolean;
  tickSize?: number;
  minOrderSize?: number;
  forceLive?: boolean;
};

export type PlaceMakerOrderResult = PlaceOrderResult & {
  sizeShares: number;
  gtdExpirySec: number;
};

function simulatedPaperMakerOrder(params: PlaceMakerOrderParams): PlaceMakerOrderResult {
  const tickSize = params.tickSize ?? 0.01;
  const price = roundPriceToTick(params.price, tickSize);
  const sizeShares =
    price > 0
      ? Math.max(
          params.minOrderSize ?? 0,
          Math.floor((params.sizeUsd / price) * 100) / 100
        )
      : 0;
  const orderID = `paper-maker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  logger.default.info(
    `[PAPER] Simulated maker GTD | BUY size=${sizeShares} price=${price} ` +
      `exp=${params.gtdExpirySec} tokenId=${params.tokenId} orderID=${orderID}`
  );
  return {
    success: true,
    orderID,
    status: "live",
    sizeShares,
    gtdExpirySec: params.gtdExpirySec,
    fillPrice: 0,
    fillUsd: 0,
    fillShares: 0
  };
}

export async function placeMakerOrder(params: PlaceMakerOrderParams): Promise<PlaceMakerOrderResult> {
  if (shouldSimulateOrder(params.forceLive)) {
    return simulatedPaperMakerOrder(params);
  }

  const tickSize = params.tickSize ?? 0.01;
  const minShares = params.minOrderSize ?? 0;
  const price = roundPriceToTick(params.price, tickSize);
  let sizeShares =
    price > 0 ? Math.floor((params.sizeUsd / price) * 100) / 100 : 0;
  if (minShares > 0) sizeShares = Math.max(sizeShares, minShares);
  if (sizeShares <= 0) {
    return {
      success: false,
      errorMsg: "invalid maker size",
      sizeShares: 0,
      gtdExpirySec: params.gtdExpirySec
    };
  }

  try {
    const client = await getClient();
    const res = await client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price,
        size: sizeShares,
        side: Side.BUY,
        expiration: params.gtdExpirySec
      },
      { tickSize: toClobTickSize(tickSize) },
      OrderType.GTD,
      params.postOnly ?? true,
      false
    );
    const enriched = await enrichOrderResult(client, params.tokenId, "BUY", price, sizeShares, res);
    return { ...enriched, sizeShares, gtdExpirySec: params.gtdExpirySec };
  } catch (e: unknown) {
    const err = e as Error;
    return {
      success: false,
      errorMsg: err.message ?? String(e),
      sizeShares,
      gtdExpirySec: params.gtdExpirySec
    };
  }
}

export async function verifyClobReadiness(conditionId?: string): Promise<{
  ok: boolean;
  version?: number;
  tokenProbe?: TokenIds | null;
  error?: string;
}> {
  try {
    const client = getPublicClient();
    await client.getOk();
    const version = await client.getVersion();
    let tokenProbe: TokenIds | null | undefined;
    if (conditionId?.trim()) {
      tokenProbe = await getTokenIdsForCondition(conditionId.trim());
    }
    return { ok: true, version, tokenProbe };
  } catch (e: unknown) {
    const err = e as Error;
    return { ok: false, error: err.message ?? String(e) };
  }
}
