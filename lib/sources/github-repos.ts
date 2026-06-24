import type { RawArticle } from "./types";

interface GitHubSearchItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string | null;
}

interface GitHubSearchResponse {
  items?: GitHubSearchItem[];
  message?: string;
}

const QUERY_SETS: Record<string, string[]> = {
  "github-quant-trading": [
    "algorithmic trading backtesting quantitative finance",
    "trading bot backtesting market data",
    "portfolio risk management quantitative trading",
  ],
  "github-creator-commerce": [
    "short video ai automation",
    "video editing automation",
    "creator tools ai",
    "ecommerce automation",
    "cross border ecommerce",
  ],
};

function compactNumber(n: number | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export async function fetchGithubRepoSearch(
  sourceId: string,
  limit = 20,
): Promise<RawArticle[]> {
  const queries = QUERY_SETS[sourceId] ?? [];
  if (queries.length === 0) return [];

  const byUrl = new Map<string, { article: RawArticle; stars: number }>();
  for (const query of queries) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", "8");

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent":
          "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, { headers });
    const json = (await response.json()) as GitHubSearchResponse;
    if (!response.ok) {
      throw new Error(json.message ?? `GitHub search failed: ${response.status}`);
    }

    for (const item of json.items ?? []) {
      if (!item.full_name || !item.html_url) continue;
      if (byUrl.has(item.html_url)) continue;
      const metaParts = [
        item.language ?? "",
        compactNumber(item.stargazers_count)
          ? `★ ${compactNumber(item.stargazers_count)}`
          : "",
        compactNumber(item.forks_count)
          ? `🍴 ${compactNumber(item.forks_count)}`
          : "",
      ].filter(Boolean);
      byUrl.set(item.html_url, {
        stars: item.stargazers_count ?? 0,
        article: {
          sourceId,
          title: item.full_name,
          url: item.html_url,
          excerpt: (item.description ?? "").slice(0, 300),
          meta: metaParts.join(" · "),
          publishedAt: item.pushed_at ? new Date(item.pushed_at) : undefined,
          category: "tech",
        },
      });
    }
  }

  return [...byUrl.values()]
    .sort(
      (a, b) =>
        b.stars - a.stars ||
        (b.article.publishedAt?.getTime() ?? 0) -
          (a.article.publishedAt?.getTime() ?? 0),
    )
    .map((item) => item.article)
    .slice(0, limit);
}
