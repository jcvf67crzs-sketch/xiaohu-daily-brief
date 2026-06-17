import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TickerAnalysis } from "../trading/signals";

export interface WatchlistPick {
  symbol: string;
  display_name: string;
  /**
   * Direction label of the current technical setup (NOT a price prediction).
   * Original "看多/看空" wording occasionally tripped Sonnet's "no investment
   * advice" guardrail into returning an empty array; the neutral technical
   * vocabulary "偏上行/偏下行/中性" (and "Bullish/Bearish/Neutral" for en
   * mode) avoids the trigger. Legacy values are kept for backwards-compat.
   */
  stance:
    | "偏上行"
    | "偏下行"
    | "中性"
    | "看多"
    | "看空"
    | "Bullish"
    | "Bearish"
    | "Neutral";
  rationale: string;
}

export interface TradingCommentary {
  market_overview: string;
  watchlist: WatchlistPick[];
  risk_caveat: string;
}

export interface TradingCommentaryInput {
  tickers: TickerAnalysis[];
  cryptoFearGreed?: FearGreedSnapshot;
  cryptoGlobal?: CryptoGlobalStats;
}

const SYSTEM_PROMPT_ZH = `你是一名克制、中性的中文宏观市场观察员。你的任务是把少量公开市场指标整理成一段**宏观市场温度说明**：帮助读者理解今天的风险偏好、波动率、A 股背景和 BTC 风险情绪。你不是投顾，不做交易建议，不预测涨跌，不挑选标的。

**严格规则**：
1. 只描述宏观温度和风险背景，不给买卖建议，不输出交易机会。
2. 所有结论必须基于输入数字：1 日/5 日涨跌、VIX、RSI、趋势、关键指数相对 52 周高低位。
3. market_overview 覆盖：美股三大指数、VIX、上证指数、BTC；如果某项缺失就忽略，不要编造。
4. watchlist 必须返回空数组 []。这个板块不再展示「今日关注」或交易 picks。
5. risk_caveat 必须包含「不构成投资建议」和「仅用于宏观市场温度观察」。

输入：JSON 数组，每个元素是一个宏观指标或市场指数，字段包括 symbol、displayName、group、currentPrice、pct1Day、pct5Day、pct52WeekHigh、pct52WeekLow、sma20/sma50/sma200、rsi14、macd/macdSignal、trend、rsiState、signals。

输出严格 JSON 对象（不要 markdown、不要任何前后缀）：
{
  "market_overview": "<180-260 字中文段落，克制说明市场温度>",
  "watchlist": [],
  "risk_caveat": "<40-80 字，包含「不构成投资建议」和「仅用于宏观市场温度观察」>"
}

**引号规则（重要！）**：JSON 字符串内的中文引用一律使用全角引号「」或""，**绝不**使用英文双引号——否则 JSON 解析失败。
`;

const SYSTEM_PROMPT_EN = `You are a restrained, neutral macro-market observer. Your job is to turn a small set of public market indicators into a **macro market temperature note**: risk appetite, volatility, China A-share backdrop, and BTC risk sentiment. You are not an investment advisor, you do not predict price direction, and you do not pick tradable names.

**Strict rules**:
1. Describe macro temperature and risk backdrop only. No trading advice, no picks.
2. Every conclusion MUST be grounded in input numbers: 1-day / 5-day moves, VIX, RSI, trend, and distance from 52-week highs/lows.
3. market_overview should cover US equity indices, VIX, Shanghai Composite, and BTC; ignore missing inputs rather than fabricating.
4. watchlist MUST be an empty array [] because this panel no longer shows "today's focus" trading picks.
5. risk_caveat MUST say this is not investment advice and is for macro-market temperature observation only.

Input: a JSON array of macro indicators / market indices with fields symbol, displayName, group, currentPrice, pct1Day, pct5Day, pct52WeekHigh, pct52WeekLow, sma20/sma50/sma200, rsi14, macd/macdSignal, trend, rsiState, signals.

Output STRICTLY a JSON object (no markdown, no prefix/suffix):
{
  "market_overview": "<120-180 word restrained English paragraph>",
  "watchlist": [],
  "risk_caveat": "<30-70 words saying this is not investment advice and is for macro-market temperature observation only>"
}

**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '" — **never** raw double-quotes, which break JSON parsing.
`;

const SYSTEM_PROMPT =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;

export async function generateTradingCommentary(
  input: TradingCommentaryInput,
): Promise<TradingCommentary> {
  const { tickers, cryptoFearGreed, cryptoGlobal } = input;
  // Slim payload — drop fields that don't help the model (no need to send
  // exchangeName/currency etc. — those are display-only)
  const payload = tickers.map((a) => ({
    symbol: a.symbol,
    displayName: a.displayName,
    group: a.group,
    currentPrice: round(a.currentPrice),
    pct1Day: round(a.pct1Day, 2),
    pct5Day: round(a.pct5Day, 2),
    pct52WeekHigh: round(a.pct52WeekHigh, 2),
    pct52WeekLow: round(a.pct52WeekLow, 2),
    sma20: roundNullable(a.sma20),
    sma50: roundNullable(a.sma50),
    sma200: roundNullable(a.sma200),
    rsi14: roundNullable(a.rsi14, 1),
    macd: roundNullable(a.macd, 4),
    macdSignal: roundNullable(a.macdSignal, 4),
    trend: a.trend,
    rsiState: a.rsiState,
    signals: a.signals.map((s) => s.label),
  }));

  // Compact context sidecars — the model should weave these into the
  // market_overview when relevant (e.g. "VIX 14 + DXY weakening + crypto
  // F&G 43 → risk-on lite").
  const contextLines: string[] = [];
  if (cryptoFearGreed) {
    const classification =
      REPORT_LOCALE === "en"
        ? cryptoFearGreed.classification
        : cryptoFearGreed.classificationCn;
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto Fear & Greed Index = ${cryptoFearGreed.value} (${classification})`
        : `加密恐慌贪婪指数 = ${cryptoFearGreed.value}（${classification}）`;
    contextLines.push(label);
  }
  if (cryptoGlobal) {
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto total market cap = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC dominance ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`
        : `加密总市值 = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC 主导率 ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`;
    contextLines.push(label);
  }

  // User prompt header = highest instruction-recency precedence. Keep the
  // market panel framed as macro temperature, not a trading watchlist.
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          `**Output language: ENGLISH ONLY.** Every string value in the JSON — market_overview and risk_caveat — MUST be written entirely in English. Do not use any Chinese characters anywhere in the output.`,
          "",
          `**Hard output constraint**: the response MUST be a single valid JSON object (starts with \`{\`, ends with \`}\`, no markdown, no prefix/suffix). The watchlist field MUST be exactly \`[]\`. Do not include trading picks, target names, or buy/sell-style ideas.`,
          "",
          contextLines.length > 0
            ? `Auxiliary context (**you MUST reference at least one of these in market_overview**):\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          `Macro indicators (${payload.length} entries, JSON array):`,
          JSON.stringify(payload),
          "",
          `Output a JSON object per the system-prompt schema. watchlist must be [].`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `**输出硬约束**：响应必须是单一合法 JSON 对象（以 \`{\` 开头以 \`}\` 结尾，不要 markdown、不要前后缀）。watchlist 字段必须精确返回空数组 \`[]\`。不要输出交易关注、标的推荐、买卖方向或机会清单。`,
          "",
          contextLines.length > 0
            ? `辅助背景（**必须在 market_overview 里至少引用一项**）：\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          `宏观指标（共 ${payload.length} 个，JSON 数组）：`,
          JSON.stringify(payload),
          "",
          `请按 system prompt 的 schema 输出 JSON 对象。watchlist 必须为 []。`,
        ]
          .filter(Boolean)
          .join("\n");

  const fallback: TradingCommentary = {
    market_overview: "",
    watchlist: [],
    risk_caveat:
      REPORT_LOCALE === "en"
        ? "The above is based on computed technical indicators from public market data and text summaries; it does NOT constitute investment advice. Past performance does not guarantee future results — market risk is your own."
        : "以上内容基于公开行情数据的技术指标计算与文本摘要，不构成任何投资建议。过去走势不代表未来表现，市场风险自负。",
  };

  // A light macro note should not spend multiple long attempts. Retry once
  // only for malformed / too-short overview output.
  const MAX_ATTEMPTS = 2;
  const RETRY_HINT =
    REPORT_LOCALE === "en"
      ? `\n\nImportant: the previous attempt was rejected because the market_overview was missing, too short, or invalid JSON. Return only the required JSON object and keep watchlist as [].`
      : `\n\n重要：上一次尝试因为 market_overview 缺失、过短或 JSON 无效被拒绝。本次只输出合法 JSON，并保持 watchlist 为 []。`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const promptForAttempt = attempt === 1 ? userPrompt : userPrompt + RETRY_HINT;
    try {
      return await callOnce(promptForAttempt, fallback);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[trading-commentary] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${msg}`,
        );
      } else {
        console.warn(
          `[trading-commentary] all ${MAX_ATTEMPTS} attempts failed: ${msg}`,
        );
      }
    }
  }
  return fallback;
}

async function callOnce(
  userPrompt: string,
  fallback: TradingCommentary,
): Promise<TradingCommentary> {
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: 120_000,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<TradingCommentary>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (strictErr) {
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      console.warn("[trading-commentary] JSON.parse failed, jsonrepair recovered");
    } catch {
      // Dump raw output for postmortem — symmetric to pipeline.ts logging.
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/trading-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/trading-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[trading-commentary] both JSON.parse and jsonrepair failed; raw at logs/trading-raw-${ts}.txt`,
        );
      } catch {
        // best-effort
      }
      throw strictErr;
    }
  }
  // Validate the light macro note. We intentionally ignore any model-returned
  // picks so the UI stays a macro temperature panel, not a trading watchlist.
  const overview = parsed.market_overview ?? "";
  if (overview.length < 40) {
    throw new Error(`market_overview too short (${overview.length} chars)`);
  }
  return {
    market_overview: overview,
    watchlist: [],
    risk_caveat: parsed.risk_caveat ?? fallback.risk_caveat,
  };
}

function round(n: number, dp = 2): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
function roundNullable(n: number | null, dp = 2): number | null {
  return n == null ? null : round(n, dp);
}
