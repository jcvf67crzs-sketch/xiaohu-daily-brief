import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  enrichFinanceNewsSummaries,
  enrichSoloBusinessArticles,
} from "../lib/ai/enrich";
import { validateBackendCredentials } from "../lib/ai/llm";
import type { ArticleInput } from "../lib/ai/pipeline";
import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import {
  MERGED_SUBGROUP_LIMITS,
  isSportsArticle,
} from "../lib/output/render";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * Top up missing summary fields on the sidecar without re-running the
 * full daily pipeline. Useful when MERGED_SUBGROUP_LIMITS bumps up
 * (e.g. politics 10 → 15) and the previous enrichment only covered
 * the old top-N. Honors REPORT_LOCALE: sources already in the target
 * language are skipped just like in daily.ts.
 *
 * Usage:
 *   npm run regen-enrich -- politics:world
 *   npm run regen-enrich -- finance:news 2026-05-15
 *
 * Follow up with `npm run render` to refresh HTML.
 */
async function main() {
  validateBackendCredentials();

  const target = process.argv[2];
  const date = process.argv[3] || todayKey();
  if (!target || !target.includes(":")) {
    throw new Error(
      `Usage: tsx scripts/regen-enrich.ts <category:subcategory> [date]`,
    );
  }
  const [category, subcategory] = target.split(":") as [
    "tech" | "finance" | "politics",
    string,
  ];
  if (
    category !== "tech" &&
    category !== "finance" &&
    category !== "politics"
  ) {
    throw new Error(`Unknown category: ${category}`);
  }

  const sidecarPath = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`Sidecar not found: ${sidecarPath}`);
  }
  const data = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as {
    date: string;
    articles: ArticleInput[];
  };

  if (target === "tech:solo-business") {
    const sourceIds = new Set(["producthunt", "yc-blog"]);
    const candidates = data.articles
      .filter((a) => sourceIds.has(a.sourceId))
      .sort((a, b) => {
        const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return bt - at;
      });
    const selected = [...sourceIds].flatMap((sourceId) =>
      candidates.filter((a) => a.sourceId === sourceId).slice(0, 12),
    );
    console.log(
      `[regen-enrich] ${target}: localizing ${selected.length} displayed articles`,
    );
    if (selected.length === 0) {
      console.log("[regen-enrich] nothing to do.");
      return;
    }

    const t0 = Date.now();
    const localized = await enrichSoloBusinessArticles(selected);
    let patched = 0;
    for (const article of selected) {
      const item = localized.get(article.url);
      if (!item) continue;
      article.title = item.title;
      article.excerpt =
        article.sourceId === "producthunt" &&
        /discussion\s*\|\s*link/i.test(article.excerpt ?? "")
          ? REPORT_LOCALE === "zh"
            ? "讨论 | 链接"
            : "Discussion | Link"
          : item.excerpt;
      article.summary = item.summary;
      patched++;
    }
    fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), "utf8");
    console.log(
      `[regen-enrich] localization done in ${((Date.now() - t0) / 1000).toFixed(1)}s, patched ${patched}/${selected.length}`,
    );
    console.log(`[regen-enrich] now run \`npm run render -- ${date}\`.`);
    return;
  }

  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  const top = data.articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort((a, b) => {
      const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, limit);

  const missing = top
    .filter((a) => !sameLocaleIds.has(a.sourceId))
    .filter((a) => !a.summary && !(a as { cnSummary?: string }).cnSummary);
  console.log(
    `[regen-enrich] ${target}: top ${top.length}, missing summary on ${missing.length}`,
  );
  if (missing.length === 0) {
    console.log("[regen-enrich] nothing to do.");
    return;
  }

  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(missing);
  console.log(
    `[regen-enrich] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${missing.length}`,
  );

  let patched = 0;
  for (const a of data.articles) {
    const s = summaries.get(a.url);
    if (s && !a.summary && !(a as { cnSummary?: string }).cnSummary) {
      a.summary = s;
      patched++;
    }
  }
  fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[regen-enrich] patched ${patched} articles in ${sidecarPath}`);
  console.log(`[regen-enrich] now run \`npm run render\` to refresh HTML.`);
}

main().catch((e) => {
  console.error("[regen-enrich] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
