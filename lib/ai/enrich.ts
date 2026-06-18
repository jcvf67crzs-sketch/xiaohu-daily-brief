import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";

interface EnrichInput {
  url: string;
  title: string;
  excerpt?: string;
  source?: string;
}

export interface LocalizedArticle {
  title: string;
  excerpt: string;
  summary: string;
}

export interface LocalizedCommunityArticle {
  title: string;
  excerpt: string;
}

const GH_SYSTEM_PROMPT_ZH = `你是一名技术编辑，负责为 GitHub Trending 项目写中文介绍。

输入：每个项目有 owner/repo 名 + 一行英文 description（可能没有）。

任务：根据 repo 名和 description，写一段 60-120 字的**通顺中文介绍**，要说清：
  1. 这个项目是做什么的，解决了什么问题
  2. 用了什么技术 / 方法（能从 repo 名 + description 推断的话）
  3. 谁会用它，典型场景是什么

写作风格：
  - 信息密度高，不写"这是一个…"这种废话开头
  - 中文术语优先，技术名词保留英文
  - 不要标题党，事实陈述为主
  - 如果信息不足，宁可短不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-120 字中文介绍>" },
    ...
  ]
}`;

const GH_SYSTEM_PROMPT_EN = `You are a technical editor writing English summaries for GitHub Trending repositories.

Input: each repo has owner/repo name + a one-line description (may be missing).

Task: write a 60-120 word **fluent English summary** covering:
  1. What the project does and what problem it solves
  2. What technology / approach (inferable from repo name + description)
  3. Who uses it, typical use case

Style:
  - High information density; avoid "This is a..." filler openings
  - Concrete; if info is insufficient, prefer shorter over fabrication
  - Factual statements only, no hype

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-120 word English summary>" },
    ...
  ]
}`;

const FINANCE_SYSTEM_PROMPT_ZH = `你是一名中文财经编辑，为英文/中文财经新闻生成**中文事实摘要**。

输入：每条新闻有 url、title、excerpt 和 source（来源媒体名）。

任务：根据 title + excerpt，生成一段 50-100 字的**中文摘要**：
  - 原文是英文 → 翻译关键信息为中文（不是逐字翻译，而是抽出要点）
  - 原文是中文 → 凝练为信息密度更高的中文
  - 必须保留：关键数字（涨跌幅、金额、利率）、机构/公司/人名、地区
  - 必须中性事实陈述，不带情绪、不标题党
  - 信息不足时宁可短，不要编造或扩展

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<50-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const FINANCE_SYSTEM_PROMPT_EN = `You are an English-language financial / world-news editor producing **factual summaries**.

Input: each news item has url, title, excerpt, and source (publisher name).

Task: from title + excerpt, write a 50-100 word **English summary**:
  - If the source text is non-English, translate the key information (not word-for-word; extract the points)
  - If already English, condense to higher information density
  - Preserve: key numbers (% moves, amounts, rates), institutions / companies / people / regions
  - Neutral factual tone — no emotion, no clickbait
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<50-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const XVIRAL_SYSTEM_PROMPT_ZH = `你是一名中文 AI 圈编辑，为 X（Twitter）上的爆款 AI 帖子生成**中文摘要**。

输入：每条帖子有 url、title、author（@handle 形式）、previewText（推文开头几句）。

注意 X 帖子的特点：
  - title 经常是博主自己起的标题党，**摘要不要照搬标题**
  - previewText 是推文实际内容开头，**信息源以它为准**
  - 内容多是 prompt 工程 / 工作流 / 工具对比 / 案例分享 / 教程

任务：生成 60-100 字中文摘要，说清楚：
  1. **博主在分享什么**（教程？工作流？踩坑？产品发布？）
  2. **关键数字/工具/概念**（如果有）：如 \"用 Claude Code 月入 4 万美元\"、\"40 条 prompt 模板\"、\"3 个 sub-agent 协作\"
  3. **价值/角度**（如果能推断）：是新发现还是老话题？

写作风格：
  - 信息密度高，不写 \"博主分享了…\" 这种废话开头
  - 中文术语优先，工具名/平台名保留英文（Claude、GPT、Codex、Cursor 等）
  - 不带营销腔，不要 "震惊！" "必看！" 这种标题党
  - 信息不足宁可短，不要硬扩

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const XVIRAL_SYSTEM_PROMPT_EN = `You are an editor producing **English summaries** of viral AI-related X (Twitter) posts.

Input: each post has url, title, author (@handle), and previewText (first lines of the tweet).

X-post patterns:
  - title is often the author's clickbait headline — **do not just rephrase the title**
  - previewText is the actual tweet opening — **treat it as the source of truth**
  - typical content: prompt engineering / workflows / tool comparisons / case studies / tutorials

Task: write a 60-100 word English summary covering:
  1. **What the author is sharing** (tutorial? workflow? gotcha? product launch?)
  2. **Key numbers / tools / concepts** (if present): e.g. "\$40k/month with Claude Code", "40 prompt templates", "3 sub-agents collaborating"
  3. **Angle / value** (if inferable): novel finding or established take?

Style:
  - High information density; avoid "The author shares..." filler
  - Keep tool / platform names in original case (Claude, GPT, Codex, Cursor, etc.)
  - No marketing tone; no "Mind-blowing!" / "Must-read!" hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const PAPERS_SYSTEM_PROMPT_ZH = `你是一名 AI 研究方向的中文编辑，为 HuggingFace 上的热门论文写**中文摘要**。

输入：每篇论文有 url、title（英文标题）、excerpt（英文摘要开头）。

任务：根据 title + excerpt，写一段 60-110 字的**中文摘要**，说清：
  1. 这篇论文解决什么问题 / 提出什么方法
  2. 核心技术思路（模型、训练方式、数据等，能从摘要推断的话）
  3. 关键结果或贡献（有量化指标就保留，如准确率、加速比）

写作风格：
  - 信息密度高，不写"这篇论文…"这种废话开头
  - 中文表达，专业术语 / 模型名 / 方法名保留英文（Transformer、RLHF、CoT、MoE 等）
  - 事实陈述，不夸大、不标题党
  - 信息不足宁可短，不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-110 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const PAPERS_SYSTEM_PROMPT_EN = `You are an AI-research editor writing **English summaries** of trending HuggingFace papers.

Input: each paper has url, title, and excerpt (start of the English abstract).

Task: from title + excerpt, write a 60-110 word **English summary** covering:
  1. What problem the paper tackles / what method it proposes
  2. The core technical approach (model, training method, data — if inferable)
  3. Key result or contribution (keep quantitative metrics if present)

Style:
  - High information density; avoid "This paper..." filler openings
  - Keep model / method names in original form (Transformer, RLHF, CoT, MoE, etc.)
  - Factual, no hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-110 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const SOLO_BUSINESS_SYSTEM_PROMPT_ZH = `你是一名中文创业与产品编辑，为 Product Hunt 和 YC Blog 条目生成中文展示内容。

输入：每条内容有 url、title、excerpt 和 source。

任务：为每条内容输出：
  1. title：准确、简洁的中文标题；产品名、公司名和专有名词可保留英文
  2. excerpt：将原始英文简介准确翻译或改写为通顺中文
  3. summary：补充一段 50-100 字中文摘要，说明产品/文章讲什么、解决什么问题，以及对个人创业者、小团队或独立开发者有什么参考价值

特殊规则：
  - Product Hunt 的 excerpt 若只有 "Discussion | Link" 等导航占位文字，统一输出"讨论 | 链接"，不要据此虚构产品功能
  - 信息不足时明确保持简短，不根据产品名猜测不存在的功能
  - YC Blog 保留人物、公司、地区、数字和职务等关键信息
  - 中文表达自然、中性，不使用营销腔或标题党

输出严格 JSON 对象，不要 markdown：
{
  "articles": [
    {
      "url": "<原 url，从输入中精确复制>",
      "title": "<中文标题>",
      "excerpt": "<中文简介或摘译>",
      "summary": "<50-100 字中文摘要>"
    }
  ]
}

所有字符串内部引用使用中文全角引号「」，不要使用未转义的英文双引号。`;

const SOLO_BUSINESS_SYSTEM_PROMPT_EN = `You are an English-language startup and product editor preparing Product Hunt and YC Blog entries.

Input: each item has url, title, excerpt, and source.

For every item, output:
  1. title: a concise, accurate English title
  2. excerpt: a fluent English rendering of the source excerpt
  3. summary: a 50-100 word factual summary explaining the product/article and its relevance to solo founders, small teams, or independent developers

Special rules:
  - If a Product Hunt excerpt only contains navigation text such as "Discussion | Link", preserve it as "Discussion | Link" and do not invent product features
  - If information is sparse, stay brief rather than guessing
  - Preserve important names, companies, regions, numbers, and roles from YC Blog
  - Use a neutral, non-promotional tone

Output STRICTLY a JSON object, no markdown:
{
  "articles": [
    {
      "url": "<exact url from input>",
      "title": "<English title>",
      "excerpt": "<English excerpt>",
      "summary": "<50-100 word English summary>"
    }
  ]
}`;

const OVERSEAS_COMMUNITY_SYSTEM_PROMPT_ZH = `你是一名中文技术社区编辑，负责忠实翻译 Hacker News、Reddit 等海外社区条目。

输入：每条内容有 url、title、excerpt 和 source。

任务：为每条内容输出：
  1. title：准确、自然的中文标题
  2. excerpt：忠实翻译已有正文片段；输入为空时必须输出空字符串

严格要求：
  - 只翻译输入中已有的信息，不总结、不解释、不补充背景、不推测链接内容
  - 公司名、产品名、人名、股票代码和技术术语可保留英文
  - 保留数字、金额、百分比和代码等关键信息
  - 不使用营销腔，不改变原文语气

输出严格 JSON 对象，不要 markdown：
{
  "articles": [
    {
      "url": "<原 url，从输入中精确复制>",
      "title": "<中文标题>",
      "excerpt": "<中文正文片段或空字符串>"
    }
  ]
}

所有字符串内部引用使用中文全角引号「」，不要使用未转义的英文双引号。`;

const OVERSEAS_COMMUNITY_SYSTEM_PROMPT_EN = `You are an English-language technology community editor translating Hacker News, Reddit, and similar community entries.

Input: each item has url, title, excerpt, and source.

For every item, output:
  1. title: an accurate, natural English title
  2. excerpt: a faithful English translation of the supplied excerpt; return an empty string when the input is empty

Strict requirements:
  - Translate only information present in the input; do not summarize, explain, add context, or infer linked content
  - Preserve company names, product names, people, ticker symbols, and technical terms where appropriate
  - Preserve numbers, amounts, percentages, and code
  - Keep the original tone and avoid promotional language

Output STRICTLY a JSON object, no markdown:
{
  "articles": [
    {
      "url": "<exact url from input>",
      "title": "<English title>",
      "excerpt": "<English excerpt or empty string>"
    }
  ]
}`;

// Pick the right localized prompt set at module init. Each enricher reaches
// in via PROMPTS.<key> so the call sites stay locale-agnostic.
const PROMPTS =
  REPORT_LOCALE === "en"
    ? { gh: GH_SYSTEM_PROMPT_EN, finance: FINANCE_SYSTEM_PROMPT_EN, xViral: XVIRAL_SYSTEM_PROMPT_EN, papers: PAPERS_SYSTEM_PROMPT_EN, soloBusiness: SOLO_BUSINESS_SYSTEM_PROMPT_EN, overseasCommunity: OVERSEAS_COMMUNITY_SYSTEM_PROMPT_EN }
    : { gh: GH_SYSTEM_PROMPT_ZH, finance: FINANCE_SYSTEM_PROMPT_ZH, xViral: XVIRAL_SYSTEM_PROMPT_ZH, papers: PAPERS_SYSTEM_PROMPT_ZH, soloBusiness: SOLO_BUSINESS_SYSTEM_PROMPT_ZH, overseasCommunity: OVERSEAS_COMMUNITY_SYSTEM_PROMPT_ZH };

const USER_PROMPT_HEADER =
  REPORT_LOCALE === "en"
    ? (n: number) => `Candidate items (${n} entries, JSON array):`
    : (n: number) => `候选条目（共 ${n} 条，JSON 数组）：`;
const USER_PROMPT_FOOTER =
  REPORT_LOCALE === "en"
    ? `Output \`{"summaries": [{"url": ..., "summary": ...}, ...]}\` — url must be copied exactly from input.`
    : `请输出 {"summaries": [{"url": ..., "summary": ...}, ...]}，url 必须精确回填输入值。`;

async function runEnrichment(
  payload: unknown[],
  systemPrompt: string,
  scope: string,
): Promise<Map<string, string>> {
  // Sonnet has a strong "match input language" reflex — when items contain
  // English titles + Chinese-tinted source names (or just a Chinese-leaning
  // RLHF default), system-prompt-only language constraints get ignored. Pin
  // the output language as the first line of the *user* prompt for recency.
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every summary string must be written entirely in English, even if the input title or description contains Chinese."
      : "**输出语言：仅中文。** 每个 summary 字段必须全部是中文，即使输入条目是英文。";
  const userPrompt = [
    langHeader,
    "",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_PROMPT_FOOTER,
  ].join("\n");

  const result = new Map<string, string>();

  try {
    const { text } = await runLlm({
      systemPrompt,
      userPrompt,
      timeoutMs: 240_000,
    });
    const cleaned = extractJson(text);

    let parsed: { summaries?: Array<{ url?: string; summary?: string }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const s of parsed.summaries ?? []) {
      if (s.url && s.summary) result.set(s.url, s.summary.trim());
    }

    // Diagnostic: if we got back substantially fewer entries than asked for,
    // dump the raw LLM output so the cause is visible without re-running.
    // Common reasons: provider max_tokens too low → truncated JSON, model
    // refused some items, URL field altered so the upstream URL-match drops
    // entries downstream. Without this dump the failure is silent.
    if (result.size < payload.length / 2 && payload.length >= 3) {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const tag = scope.replace(/[^a-z0-9]/gi, "-");
        fs.writeFileSync(
          `logs/enrich-undercount-${tag}-${ts}.txt`,
          `scope=${scope}\nrequested=${payload.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
          "utf8",
        );
        console.warn(
          `[enrich] ${scope}: undercount ${result.size}/${payload.length} — raw dumped to logs/enrich-undercount-${tag}-${ts}.txt`,
        );
      } catch {
        // Can't write log (read-only fs?) — non-fatal, just skip.
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} failed: ${msg}`);
  }

  return result;
}

async function runArticleLocalization(
  payload: EnrichInput[],
): Promise<Map<string, LocalizedArticle>> {
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every title, excerpt, and summary must be written in English."
      : "**输出语言：仅中文。** title、excerpt 和 summary 必须使用中文；产品名、公司名和专有名词可保留原文。";
  const userPrompt = [
    langHeader,
    "",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    REPORT_LOCALE === "en"
      ? `Output {"articles": [{"url": ..., "title": ..., "excerpt": ..., "summary": ...}, ...]}; copy every url exactly.`
      : `请输出 {"articles": [{"url": ..., "title": ..., "excerpt": ..., "summary": ...}, ...]}，url 必须精确回填输入值。`,
  ].join("\n");
  const result = new Map<string, LocalizedArticle>();

  try {
    const { text } = await runLlm({
      systemPrompt: PROMPTS.soloBusiness,
      userPrompt,
      timeoutMs: 240_000,
    });
    const cleaned = extractJson(text);
    let parsed: {
      articles?: Array<{
        url?: string;
        title?: string;
        excerpt?: string;
        summary?: string;
      }>;
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const article of parsed.articles ?? []) {
      if (
        article.url &&
        article.title &&
        article.excerpt &&
        article.summary
      ) {
        result.set(article.url, {
          title: article.title.trim(),
          excerpt: article.excerpt.trim(),
          summary: article.summary.trim(),
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] solo-business localization failed: ${msg}`);
  }

  return result;
}

async function runCommunityLocalization(
  payload: EnrichInput[],
): Promise<Map<string, LocalizedCommunityArticle>> {
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Translate title and excerpt faithfully; do not add information."
      : "**输出语言：仅中文。** 忠实翻译 title 和 excerpt，不得补充输入中不存在的信息。";
  const userPrompt = [
    langHeader,
    "",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    REPORT_LOCALE === "en"
      ? `Output {"articles": [{"url": ..., "title": ..., "excerpt": ...}, ...]}; copy every url exactly.`
      : `请输出 {"articles": [{"url": ..., "title": ..., "excerpt": ...}, ...]}，url 必须精确回填输入值。`,
  ].join("\n");
  const result = new Map<string, LocalizedCommunityArticle>();

  try {
    const { text } = await runLlm({
      systemPrompt: PROMPTS.overseasCommunity,
      userPrompt,
      timeoutMs: 240_000,
    });
    const cleaned = extractJson(text);
    let parsed: {
      articles?: Array<{
        url?: string;
        title?: string;
        excerpt?: string;
      }>;
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const article of parsed.articles ?? []) {
      if (
        article.url &&
        article.title &&
        typeof article.excerpt === "string"
      ) {
        result.set(article.url, {
          title: article.title.trim(),
          excerpt: article.excerpt.trim(),
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] overseas-community localization failed: ${msg}`);
  }

  return result;
}

/**
 * Generate Chinese summaries for a batch of GitHub Trending repos in
 * a single Claude CLI call. Failures are non-fatal — caller gets an
 * empty map and the rendering simply omits summaries.
 */
export async function enrichGithubTrendingSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    repo: it.title,
    description: (it.excerpt ?? "").slice(0, 200),
  }));
  return runEnrichment(payload, PROMPTS.gh, "GH summaries");
}

/**
 * Generate Chinese factual summaries for the (up to ~50) finance news
 * items that will be shown in the raw panel. One Sonnet call covers
 * the whole batch.
 */
export async function enrichFinanceNewsSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    source: it.source ?? "",
    excerpt: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.finance, "finance summaries");
}

/**
 * Generate Chinese summaries for viral X posts. Different prompt from
 * finance because X tweets are usually clickbait titles + first-person
 * tutorial / case-study text — the model needs to dig past the headline.
 */
export async function enrichXViralSummaries(
  items: Array<EnrichInput & { author?: string }>,
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    author: it.author ?? "",
    previewText: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.xViral, "X-viral summaries");
}

/**
 * Generate summaries for trending HuggingFace papers. Separate prompt
 * from finance/GH because papers need a problem/method/result framing
 * and the excerpt is an English research abstract.
 */
export async function enrichTrendingPapersSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
  }));
  return runEnrichment(payload, PROMPTS.papers, "papers summaries");
}

export async function enrichSoloBusinessArticles(
  items: EnrichInput[],
): Promise<Map<string, LocalizedArticle>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
    source: it.source ?? "",
  }));
  return runArticleLocalization(payload);
}

export async function enrichOverseasCommunityArticles(
  items: EnrichInput[],
): Promise<Map<string, LocalizedCommunityArticle>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
    source: it.source ?? "",
  }));
  return runCommunityLocalization(payload);
}

export function localizeHackerNewsStats(
  excerpt: string | undefined,
): string | undefined {
  const match = excerpt?.trim().match(
    /^(\d+)\s+points?\s*·\s*(\d+)\s+comments?$/i,
  );
  return match ? `${match[1]} 积分 · ${match[2]} 条评论` : undefined;
}
