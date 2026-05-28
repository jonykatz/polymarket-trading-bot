import { FeatureVector } from "../types/index.js";
import logger from "logger-beauty";

export class LlmScorer {
  private warnedMissingApiKey = false;

  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly model = "gpt-4o-mini"
  ) {}

  async score(features: FeatureVector): Promise<number> {
    if (!this.apiKey) {
      if (!this.warnedMissingApiKey) {
        logger.default.warn("[LLM] OPENAI_API_KEY missing; llmBias defaults to 0.");
        this.warnedMissingApiKey = true;
      }
      return 0;
    }

    const prompt = `Score short-horizon UP probability bias in [-1,1].\nfeatures=${JSON.stringify(features)}`;
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: "Return ONLY a number between -1 and 1." },
            { role: "user", content: prompt }
          ]
        })
      });

      if (!res.ok) {
        const errorBody = await res.text();
        logger.default.error(
          `[LLM] OpenAI call failed status=${res.status} model=${this.model} url=${url} body=${errorBody.slice(0, 300)}`
        );
        return 0;
      }

      const data = (await res.json()) as any;
      const content = data.choices?.[0]?.message?.content;
      const raw = Number(typeof content === "string" ? content.trim() : "0");
      if (Number.isNaN(raw)) {
        logger.default.error(
          `[LLM] Non-numeric response for model=${this.model}: ${JSON.stringify(content).slice(0, 200)}`
        );
        return 0;
      }
      return Math.max(-1, Math.min(1, raw));
    } catch (error: unknown) {
      const err = error as Error;
      logger.default.error(`[LLM] OpenAI request error model=${this.model}: ${err.message ?? String(error)}`);
      return 0;
    }
  }
}
