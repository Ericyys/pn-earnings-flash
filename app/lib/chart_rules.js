// 公司繪圖規範（chart_rules.json）
//
// 架構：
//   通用規則（程式固定，每家公司一樣）：選圖門檻、數字格式、年增率標示、配色版面、驗算。
//   公司繪圖規範（本檔定義格式與預設值）：每家公司可以調整「怎麼畫、怎麼算」，存成
//     history/<市場>/<代號>/chart_rules.json，下次出圖自動套用。規範沒寫的項目一律用預設值，
//     所以新公司不用設定也能直接出圖。
//
// 規範只能改呈現與計算方式，不能改原始數字：所有數字都來自核對過的數據表。
// 計算方式只能從下面列出的選項中選（每一種都只用核對過的原始數字），選了非預設的算法會在圖卡頁尾註明。

export const RULES_VERSION = "1.0";

/** 預設值：等於通用規則 */
export const DEFAULT_RULES = {
  rules_version: RULES_VERSION,
  deck: { include: [], exclude: [] },           // 條件圖卡：一定要做／一定不做（其餘依 rules/triggers.json 自動判斷）
  labels: {},                                    // 科目中文名稱：{ 項目代號: 中文 }，確認過就記住
  calc: {
    gross_profit: "auto",                        // 毛利的算法（見 CALC_OPTIONS）
    cogs_items: [],                              // gross_profit = custom_cogs 時：哪些費用列算進營業成本
    eps_yoy: "stated_first",
    free_cash_flow: "stated",
  },
  A1: { kpis: ["revenue", "operating_margin", "eps"] },
  C: { show_pct: true, merge: { name: "其他營業費用", items: [] } },
  B: { dimension: "auto", reconciling: {}, other_below_pct: 0, show_pct: true, pct_position: "inside" },
  D: { series: ["gross_margin", "operating_margin", "net_margin"] },
  G: { items: ["operating_cash_flow", "capex", "free_cash_flow", "buybacks", "dividends"] },
  K1: { hide: [] },
};

/** 可選的計算方式（只能從這裡選；每一種都只用核對過的原始數字） */
export const CALC_OPTIONS = {
  gross_profit: {
    name: "毛利",
    options: {
      auto: "原文有毛利就用原文；沒有時用「營收 − 營業成本」計算（預設）",
      stated: "只用原文列出的毛利；原文沒有就不畫毛利",
      revenue_minus_cogs: "一律用「營收 − 營業成本」計算",
      custom_cogs: "營業成本由指定的費用列組成：營收 − 指定費用列合計（例如公司把多列成本分開列示）",
      none: "不畫毛利（例如券商、銀行沒有營業成本的概念）",
    },
  },
  eps_yoy: {
    name: "EPS 年增率",
    options: {
      stated_first: "公司有寫、且與公布 EPS 一致時用公司的數字；否則用公布 EPS 計算（預設）",
      reported_eps: "一律用公布的 EPS 計算（本季 ÷ 去年同期）",
      net_income_per_share: "用「淨利 ÷ 加權平均股數」計算（四捨五入前的 EPS）",
    },
  },
  free_cash_flow: {
    name: "自由現金流",
    options: {
      stated: "只用公司公布的數字；沒公布就不畫（預設）",
      ocf_minus_capex: "用「營業現金流 − 資本支出」計算（公司自己的定義就是這樣時才選）",
    },
  },
};

/** A1 可選的重點數字 */
export const A1_KPI_OPTIONS = {
  revenue: "營收", operating_margin: "營益率", eps: "EPS", gross_margin: "毛利率",
  net_margin: "淨利率", operating_income: "營業利益", net_income: "淨利",
};
export const D_SERIES_OPTIONS = { gross_margin: "毛利率", operating_margin: "營益率", net_margin: "淨利率" };
export const G_ITEM_OPTIONS = { operating_cash_flow: "營業現金流", capex: "資本支出", free_cash_flow: "自由現金流", buybacks: "庫藏股買回", dividends: "現金股利" };
export const CONDITIONAL_CARDS = { B: "營收拆解", D: "利潤率", G: "現金流量與股東回饋" };

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** 預設值＋公司規範（深層合併；陣列整個取代）。公司規範格式不對的欄位忽略，不讓規範壞掉整個出圖 */
export function mergeRules(company) {
  const out = structuredClone(DEFAULT_RULES);
  // labels、B.reconciling 是「代號 → 值」的對照表，鍵由各公司決定
  const MAPS = { labels: "string", reconciling: "boolean" };
  const merge = (dst, src) => {
    if (!isObj(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (!(k in dst)) continue; // 不認得的欄位不採用
      if (MAPS[k] && isObj(v)) { for (const [kk, vv] of Object.entries(v)) if (typeof vv === MAPS[k]) dst[k][kk] = vv; }
      else if (isObj(dst[k]) && isObj(v)) merge(dst[k], v);
      else if (Array.isArray(dst[k]) ? Array.isArray(v) : typeof v === typeof dst[k]) dst[k] = structuredClone(v);
    }
  };
  merge(out, company);
  if (!CALC_OPTIONS.gross_profit.options[out.calc.gross_profit]) out.calc.gross_profit = "auto";
  if (!CALC_OPTIONS.eps_yoy.options[out.calc.eps_yoy]) out.calc.eps_yoy = "stated_first";
  if (!CALC_OPTIONS.free_cash_flow.options[out.calc.free_cash_flow]) out.calc.free_cash_flow = "stated";
  return out;
}

/** 只留下與預設不同的部分（下載的 chart_rules.json 只記公司特有的設定，比較好讀） */
export function diffRules(rules) {
  const diff = (a, d) => {
    if (isObj(a) && isObj(d)) {
      const o = {};
      for (const k of Object.keys(a)) {
        const x = diff(a[k], d[k]);
        if (x !== undefined) o[k] = x;
      }
      return Object.keys(o).length ? o : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(d) ? undefined : a;
  };
  return diff(rules, DEFAULT_RULES) || {};
}

/** 與預設不同的設定，轉成給人看的清單 */
export function describeChanges(rules) {
  const d = diffRules(rules);
  const out = [];
  for (const k of Object.keys(d.calc || {})) if (CALC_OPTIONS[k]) out.push(`${CALC_OPTIONS[k].name}：${CALC_OPTIONS[k].options[rules.calc[k]]}`);
  if (d.calc?.cogs_items) out.push(`營業成本組成：${rules.calc.cogs_items.join("、")}`);
  if (d.deck?.include) out.push(`一定要做：${rules.deck.include.join("、")}`);
  if (d.deck?.exclude) out.push(`一定不做：${rules.deck.exclude.join("、")}`);
  if (d.labels) out.push(`科目中文名稱 ${Object.keys(rules.labels).length} 項`);
  for (const card of ["A1", "C", "B", "D", "G", "K1"]) if (d[card]) out.push(`${card}：${Object.keys(d[card]).join("、")} 已調整`);
  return out;
}
