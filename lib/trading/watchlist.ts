export type AssetGroup =
  | "us-equity" // 美股蓝筹 + ETF
  | "crypto" // 加密货币
  | "china-equity" // 中概股 / 港股
  | "commodity-fx" // 商品 + 外汇
  | "macro"; // 宏观信号（恐慌指数 / 利率 / 美元指数）

export interface TickerDef {
  symbol: string; // Yahoo Finance symbol
  displayName: string; // 中文展示名
  displayNameEn?: string; // English display name (falls back to displayName if absent)
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "us-equity": "美股 / ETF",
  crypto: "加密货币",
  "china-equity": "中概 / 港股",
  "commodity-fx": "商品 / 外汇",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "us-equity": "US Stocks / ETF",
  crypto: "Crypto",
  "china-equity": "China / HK",
  "commodity-fx": "Commodities / FX",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "macro",
  "us-equity",
  "crypto",
  "china-equity",
  "commodity-fx",
];

export const WATCHLIST: TickerDef[] = [
  // === 宏观温度计 ===
  { symbol: "^GSPC", displayName: "标普 500", displayNameEn: "S&P 500", group: "us-equity" },
  { symbol: "^DJI", displayName: "道琼斯工业指数", displayNameEn: "Dow Jones Industrial Average", group: "us-equity" },
  { symbol: "^IXIC", displayName: "纳斯达克综合指数", displayNameEn: "Nasdaq Composite", group: "us-equity" },
  { symbol: "^VIX", displayName: "VIX 恐慌指数", displayNameEn: "VIX (Volatility)", group: "macro" },
  { symbol: "000001.SS", displayName: "上证指数", displayNameEn: "SSE Composite", group: "china-equity" },
  { symbol: "BTC-USD", displayName: "Bitcoin", group: "crypto" },
];
