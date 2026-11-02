// 公司規範（company_rules.json）：各公司的財務算式與科目中文名稱
//
// 每家公司新聞稿的算法不太一樣（EPS 的分子、毛利包含哪些成本、營收拆解哪些是小計或調節項目、自由現金流的定義…）。
// 這些差異不改程式，而是記在該公司的規範裡：
//   history/<市場>/<代號>/company_rules.json
// 出圖工具每次自動讀取；規範沒寫的項目一律用通用算式（預設值），所以新公司不用設定也能直接核對、出圖。
//
// 規範只改「怎麼算」，不改原始數字：所有數字都來自核對過的數據表。算式只能從 CALC_OPTIONS 中選，
// 每一種都只用核對過的原始數字；選了非預設的算式，圖卡頁尾會註明。
// 規範同時套用在自動檢查（勾稽）與圖卡，所以選對公司的算式後，勾稽不再誤報，圖卡數字也與新聞稿一致。
// 要畫哪幾張圖卡、怎麼排版，一律由選圖規則決定（rules/triggers.json），不在規範裡。

export const RULES_VERSION = "1.0";

/** 預設值＝通用算式 */
export const DEFAULT_RULES = {
  rules_version: RULES_VERSION,
  calc: {
    eps_numerator: "parent",     // EPS 的分子（見 CALC_OPTIONS）
    gross_profit: "auto",        // 毛利的算法
    cogs_items: [],              // gross_profit = custom_cogs 時：哪些費用列算進營業成本
    eps_yoy: "stated_first",     // EPS 年增率
    free_cash_flow: "stated",    // 自由現金流
  },
  revenue_items: {
    reconciling: {},             // 調節項目：{ 代號: true/false }。列在部門小計之外、但計入總營收（不畫進柱子，放註腳）
    subtotal: [],                // 小計列：AI 把小計和明細一起抽進來時，小計不計入加總、不畫
  },
  labels: {},                    // 科目中文名稱：{ 項目代號: 中文 }，確認過就記住
};

/** 可選的算式（只能從這裡選；每一種都只用核對過的原始數字） */
export const CALC_OPTIONS = {
  eps_numerator: {
    name: "EPS 的分子",
    options: {
      parent: "歸屬母公司業主淨利（預設）",
      common: "歸屬普通股股東淨利（淨利扣除特別股股利；原文有這一列就用原文，否則用歸屬母公司淨利 − 特別股股利）",
    },
  },
  gross_profit: {
    name: "毛利",
    options: {
      auto: "原文有毛利就用原文；沒有時用「營收 − 營業成本」計算（預設）",
      stated: "只用原文列出的毛利；原文沒有就不畫毛利",
      revenue_minus_cogs: "一律用「營收 − 營業成本」計算",
      custom_cogs: "營業成本由指定的列組成：營收 − 指定列合計（公司把多列成本分開列示時）",
      none: "不畫毛利（例如券商、銀行沒有營業成本的概念）",
    },
  },
  eps_yoy: {
    name: "EPS 年增率",
    options: {
      stated_first: "公司有寫、且與公布 EPS 一致時用公司的數字；否則用公布 EPS 計算（預設）",
      reported_eps: "一律用公布的 EPS 計算（本季 ÷ 去年同期）",
      net_income_per_share: "用「EPS 的分子 ÷ 加權平均股數」計算（四捨五入前的 EPS）",
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

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** 預設值＋公司規範（深層合併；陣列整個取代）。格式不對或不認得的欄位忽略，不讓規範壞掉整個流程 */
export function mergeRules(company) {
  const out = structuredClone(DEFAULT_RULES);
  // labels、reconciling 是「代號 → 值」的對照表，鍵由各公司決定
  const MAPS = { labels: "string", reconciling: "boolean" };
  const merge = (dst, src) => {
    if (!isObj(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (!(k in dst)) continue;
      if (MAPS[k] && isObj(v)) { for (const [kk, vv] of Object.entries(v)) if (typeof vv === MAPS[k]) dst[k][kk] = vv; }
      else if (isObj(dst[k]) && isObj(v)) merge(dst[k], v);
      else if (Array.isArray(dst[k]) ? Array.isArray(v) : typeof v === typeof dst[k]) dst[k] = structuredClone(v);
    }
  };
  merge(out, company);
  for (const k of Object.keys(CALC_OPTIONS)) if (!CALC_OPTIONS[k].options[out.calc[k]]) out.calc[k] = DEFAULT_RULES.calc[k];
  return out;
}

/** 只留下與預設不同的部分（下載的 company_rules.json 只記這家公司特有的設定） */
export function diffRules(rules) {
  const diff = (a, d) => {
    if (isObj(a) && isObj(d)) {
      const o = {};
      for (const k of Object.keys(a)) { const x = diff(a[k], d[k]); if (x !== undefined) o[k] = x; }
      return Object.keys(o).length ? o : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(d) ? undefined : a;
  };
  return diff(rules, DEFAULT_RULES) || {};
}

/** 與預設不同的設定，轉成給人看的清單 */
export function describeChanges(rules) {
  const out = [];
  for (const k of Object.keys(CALC_OPTIONS)) if (rules.calc[k] !== DEFAULT_RULES.calc[k]) out.push(`${CALC_OPTIONS[k].name}：${CALC_OPTIONS[k].options[rules.calc[k]]}`);
  if (rules.calc.gross_profit === "custom_cogs" && rules.calc.cogs_items.length) out.push(`營業成本組成：${rules.calc.cogs_items.join("、")}`);
  const rec = Object.entries(rules.revenue_items.reconciling);
  if (rec.length) out.push(`調節項目：${rec.map(([k, v]) => `${k}${v ? "" : "（不是）"}`).join("、")}`);
  if (rules.revenue_items.subtotal.length) out.push(`小計列：${rules.revenue_items.subtotal.join("、")}`);
  const nl = Object.keys(rules.labels).length;
  if (nl) out.push(`科目中文名稱 ${nl} 項`);
  return out;
}
