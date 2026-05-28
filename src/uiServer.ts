import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { validateUiEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import { getWalletWinrates } from "./connectors/walletPerformance.js";

validateUiEnv();
import { buildFeatures } from "./engine/features.js";
import { predict } from "./engine/predictor.js";
import { LlmScorer } from "./models/llmScorer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = path.resolve(__dirname, "../ui");

const connector = new PolymarketConnector(cfg.polymarketRestBase);
const llm = new LlmScorer(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);

async function getSnapshot() {
  const ticks = await connector.getMarketTicks(20);
  const marketMeta = await connector.getCurrentMarketInfo();
  const marketId = ticks[ticks.length - 1].marketId;
  const whale = await connector.getWhaleFlow(marketId);
  const wallets = (whale.participants ?? []).map((p) => p.wallet);
  const walletWinrates = await getWalletWinrates(wallets);
  const features = await buildFeatures(ticks, whale, walletWinrates);
  const llmBias = await llm.score(features);
  const pred = predict(features, llmBias);
  const eligibleWallets = (whale.participants ?? [])
    .map((p) => ({
      wallet: p.wallet,
      winrate: walletWinrates.get(p.wallet) ?? 0,
      yesNotional: p.yesNotional,
      noNotional: p.noNotional,
      netYes: p.netYes,
      gross: p.gross
    }))
    .filter((w) => w.winrate >= cfg.whaleMinWinrate)
    .sort((a, b) => b.gross - a.gross);

  const gate = {
    confidenceThreshold: cfg.confidenceThreshold,
    passConfidence: pred.confidence >= cfg.confidenceThreshold,
    forceExitSeconds: cfg.forceExitSeconds,
    passTime: marketMeta.remainingSec < 0 || marketMeta.remainingSec > cfg.forceExitSeconds + 5,
    whaleMinWinrate: cfg.whaleMinWinrate
  };
  return {
    marketId,
    marketMeta,
    currentYes: features.yesPrice,
    whale,
    eligibleWallets: eligibleWallets.slice(0, 20),
    gate,
    indicators: {
      emaFast: features.emaFast,
      emaSlow: features.emaSlow,
      emaSignal: features.emaSignal,
      rsi: features.rsi,
      trendScore: features.trendScore
    },
    prediction: pred,
    ts: Date.now()
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/api/prediction") {
      const data = await getSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    const filePath = url.pathname === "/"
      ? path.join(uiDir, "index.html")
      : path.join(uiDir, url.pathname.replace(/^\//, ""));

    if (!filePath.startsWith(uiDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

const port = 8787;
server.listen(port, () => {
  console.log(`UI running at http://localhost:${port}`);
});
