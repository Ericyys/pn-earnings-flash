// 計算層：數據表 → 自動檢查 → 指標 → 選圖 → 圖卡 spec
// 純計算，不碰畫面；瀏覽器與 Node 都能執行。
//
// 通用算式＋公司規範（ctx.rules，見 lib/company_rules.js）：
//   各公司新聞稿的算法可能不同（EPS 的分子、毛利包含哪些成本、營收拆解的小計與調節項目…），
//   這些差異記在公司規範裡，同時套用在自動檢查與圖卡：選對公司的算式後勾稽不再誤報，圖卡數字也與新聞稿一致。
//   勾稽不通過時，若換成某個公司算式就相符，檢查結果會附上建議（check.suggest），核對畫面可一鍵採用。
//   規範只改「怎麼算」，數字一律來自核對過的數據表。要畫哪幾張圖卡由選圖規則決定；資料不完整的圖卡不產出。
//
// analyze(fs, ctx) 回傳：
//   checks     自動檢查結果（pass／fail／warn／skip；可能附 suggest：{ patch, text }）
//   derived    依損益表科目計算、原文沒有直接列出的數字（圖卡底部會註明）
//   derivable  可計算的數字清單（核對畫面第三層列出，供確認原文確實沒有這一列）
//   metrics    指標（年增率、利潤率、佔比…）
//   selection  這次做哪幾張、哪些規則觸發、哪些因資料不足略過、哪些因資料不完整不出圖（incomplete）
//   cards      給底稿的 spec（A1、C、條件模組、K1）
//   company    公司規範畫面用的資訊：科目名稱、可設定的項目、規範中本季找不到的項目
//
// ctx: { profile, company, triggers, labels, history, overrides, rules }
//   overrides：使用者在第三層對「不通過」選了「數據正確」的檢查 id 清單
//   rules：公司規範（mergeRules 之後的完整設定）；省略時用通用算式

import { amount as fmt2, fixed1 as fmt1, fixed } from "./format.js";
import { parseWithDecimals, itemDecimals, decOf } from "./decimals.js";
import { mergeRules } from "./company_rules.js";

// ───────── 小工具 ─────────
const num = (dp) => (dp && typeof dp.value === "number" ? dp.value : null);
const cur = (pair) => num(pair?.current);
const pri = (pair) => num(pair?.prior_year);
// 年增率：只在去年同期 > 0 時計算；不以分母取絕對值的方式處理負基期（去年同期 ≤ 0 → null）
const yoy = (a, b) => (a !== null && b !== null && b > 0 ? (a / b - 1) * 100 : null);
/**
 * 圖卡上的年增率標示（依序判斷，符合第一個條件即採用）：
 *   1. 去年同期 = 0 → N/M
 *   2. 去年同期 > 0、本期 ≥ 0 → 百分比（▲▼；四捨五入後為 0.0% 不加箭頭）
 *   3. 去年同期 > 0、本期 < 0 → 轉負
 *   4. 去年同期 < 0、本期 > 0 → 轉正
 *   5. 去年同期 < 0、本期 ≤ 0 → N/M
 * 回傳數字（百分比）或 { label }（底稿用中性灰色顯示，不加 ▲▼）；缺資料回傳 null。
 * pct：情況 2 要顯示的百分比（例如採用公司公布的 EPS 年增率），省略時自行計算。
 */
const yoyShown = (a, b, pct) => {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  if (b === 0) return { label: "N/M" };
  if (b > 0) return a >= 0 ? (pct ?? yoy(a, b)) : { label: "轉負" };
  return a > 0 ? { label: "轉正" } : { label: "N/M" };
};
const yoyText = (v) => (v === null ? "—" : typeof v === "object" ? v.label : `${fmt1(v)}%`);
/** 項數最少的子集合（最多 12 項，依項數由少到多找），符合 ok(sub) 就回傳；找不到回傳 null */
function smallestSubset(list, ok, maxSize = 4) {
  if (!list.length || list.length > 12) return null;
  const n = list.length;
  for (let size = 1; size <= Math.min(maxSize, n); size++) {
    const idx = [...Array(size).keys()];
    while (true) {
      const sub = idx.map((i) => list[i]);
      if (ok(sub)) return sub;
      let i = size - 1;
      while (i >= 0 && idx[i] === n - size + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
    }
  }
  return null;
}
const pctOf = (a, b) => (a !== null && b !== null && b !== 0 ? (a / b) * 100 : null);

const UNIT_POWER = { ones: 0, thousands: 3, millions: 6, billions: 9 };
const DISPLAY_POWER = { billions: 9, hundred_millions: 8, millions: 6 };
const DISPLAY_LABEL = { billions: "B", hundred_millions: "億", millions: "M" };

/** 依標籤正規化，用來辨識「營業成本」等列 */
const norm = (s) => String(s || "").toLowerCase().replace(/[*:：]/g, "").replace(/\s+/g, " ").trim();

const HAS_CJK = /[\u3400-\u9fff]/;

/**
 * 科目中文名稱。圖卡標籤一律中文，依序採用：
 *   1. 公司規範的 labels（使用者確認或修改過的名稱，會記住）
 *   2. 公司設定檔的 label_zh（companies/*.json）
 *   3. 原文本身就是中文（台股）
 *   4. 科目對照表（references/labels_zh.json）
 *   5. AI 的譯名 label_zh（台灣常用財報用語）→ 核對畫面「科目中文名稱」需要確認
 *   6. 都沒有 → 標為缺少中文名稱（必須填入，不直接印英文）
 * id：項目代號（例如 opex:technology_and_development、geo:ucan），公司規範用它記住名稱
 */
function nameOf(item, id, ctx, companyZh) {
  const en = item.label_source;
  const at = { en, id, ai: String(item.label_zh || "").trim() || null };
  const ruled = ctx.rules?.labels?.[id];
  if (ruled && HAS_CJK.test(ruled)) return { ...at, zh: ruled, origin: "rules" };
  if (companyZh) return { ...at, zh: companyZh, origin: "company" };
  if (HAS_CJK.test(en)) return { ...at, zh: en, origin: "source" };
  const dict = ctx.labels?.[norm(en)];
  if (dict) return { ...at, zh: dict, origin: "dict" };
  const ai = String(item.label_zh || "").trim();
  if (HAS_CJK.test(ai)) return { ...at, zh: ai, origin: "ai" };
  return { ...at, zh: en, origin: "missing" };
}

// ───────── 主函式 ─────────
export function analyze(fs, ctx) {
  const { profile, company = {}, triggers, history = [] } = ctx;
  const checks = [];
  const derived = [];
  const derivable = [];
  const dropped = [];
  const rules = ctx.rules || mergeRules({});
  ctx = { ...ctx, rules };
  // 圖卡上實際用到的科目名稱（核對畫面列出；AI 譯名或缺少中文名稱的需要確認）
  const labelsUsed = new Map();
  const useName = (n) => { labelsUsed.set(n.id, n); return n.zh; };
  const ruleIssues = []; // 公司規範指到、但本季找不到的項目：改用通用算式，並在核對畫面提示
  const incomplete = []; // 資料不完整而不產出的圖卡：{ card, reason }
  const add = (id, label, status, detail = "", suggest) => checks.push({ id, label, status, detail, ...(suggest ? { suggest } : {}) });
  const near = (a, b, t) => a !== null && b !== null && Math.abs(a - b) <= t;
  // 覆寫：使用者確認「數據正確」的不通過項目。為了不畫出與數字矛盾的圖，受影響的那一段會自動不畫。
  // 注意：overridden(id) 只能在該項檢查「已經加入 checks 之後」呼叫。
  const OV = new Set(ctx.overrides || []);
  const overridden = (id) => OV.has(id) && checks.some((c) => c.id === id && c.status === "fail");

  const m = fs.meta;
  const IS = fs.income_statement;
  const srcPow = UNIT_POWER[m.monetary_unit] ?? 6;
  const dispUnit = profile.defaults.display_unit;
  const dispPow = DISPLAY_POWER[dispUnit];
  const toDisp = (v) => (v === null ? null : v * Math.pow(10, srcPow - dispPow));
  const unitText = `${profile.defaults.display_currency} ${DISPLAY_LABEL[dispUnit]}`;
  const tol = (terms = 1) => Math.max(1, terms); // 四捨五入容許：原文最小單位 × 項數

  // ── 2. 費用列：把「營業成本」與其他費用分開（兩種 AI 的放法都能處理）
  const cogsAliases = (profile.line_item_aliases.cost_of_revenue || []).map(norm);
  const pq0 = (pair) => { const v = num(pair?.prior_quarter); return v === null ? null : Math.abs(v); };
  let cogs = { c: cur(IS.cost_of_revenue), p: pri(IS.cost_of_revenue) };
  let items = [];
  for (const it of fs.operating_expense_items || []) {
    const c = cur(it.amount), p = pri(it.amount);
    if (cogsAliases.includes(norm(it.label_source))) {
      if (cogs.c === null) cogs = { c, p };
      continue; // 營業成本不放進營業費用，避免重複扣除
    }
    items.push({ key: it.key, label: it.label_source, nm: nameOf(it, `opex:${it.key}`, ctx), c: Math.abs(c), p: p === null ? null : Math.abs(p), q: pq0(it.amount) });
  }
  if (cogs.c !== null) cogs = { c: Math.abs(cogs.c), p: cogs.p === null ? null : Math.abs(cogs.p) };
  const cogsBase = cogs, itemsBase = items; // 通用定義（算式建議用）
  let cogsQ = null; // 上一季營業成本（季變動用）

  // ── 2a. 公司算式：營業成本由指定的列組成（calc.gross_profit = custom_cogs）
  //   指定的費用列移到營業成本；毛利、營業利益勾稽與圖卡都用這個定義（與公司新聞稿的毛利一致）
  const gpMode = rules.calc.gross_profit;
  let cogsNote = "";
  if (gpMode === "custom_cogs") {
    const keys = rules.calc.cogs_items || [];
    const picked = items.filter((it) => keys.includes(it.key));
    const useCor = keys.includes("cost_of_revenue") && cogs.c !== null;
    for (const k of keys) if (k !== "cost_of_revenue" && !items.some((it) => it.key === k)) ruleIssues.push(`營業成本組成：本季找不到費用列「${k}」`);
    if (picked.length || (useCor && keys.length > 1)) {
      const sum = (k) => { const parts = [...(useCor ? [cogs[k]] : []), ...picked.map((it) => it[k])]; return parts.some((x) => x === null || x === undefined) ? null : parts.reduce((a, x) => a + x, 0); };
      const qParts = [...(useCor ? [pq0(IS.cost_of_revenue)] : []), ...picked.map((it) => it.q)];
      cogsQ = qParts.every((x) => x !== null) ? qParts.reduce((a, x) => a + x, 0) : null;
      cogs = { c: sum("c"), p: sum("p") };
      items = items.filter((it) => !keys.includes(it.key));
      // 頁尾註明營業成本的組成：含原本的營業成本列時寫「營業成本含 X」，否則寫「營業成本為 X、Y 合計」
      const names = picked.map((it) => useName(it.nm)).join("、");
      cogsNote = useCor ? `營業成本含${names}` : `營業成本為${names}${picked.length > 1 ? "合計" : ""}`;
    } else ruleIssues.push("營業成本組成：沒有指定要併入的費用列，改用通用算式");
  }

  const rev = { c: cur(IS.revenue), p: pri(IS.revenue) };
  const oi = { c: cur(IS.operating_income), p: pri(IS.operating_income) };
  const pretax = { c: cur(IS.pretax_income), p: pri(IS.pretax_income) };
  const ni = { c: cur(IS.net_income), p: pri(IS.net_income) };
  const niP = { c: cur(IS.net_income_to_parent) ?? ni.c, p: pri(IS.net_income_to_parent) ?? ni.p };
  // 歸屬普通股股東淨利：原文有這一列就用；否則歸屬母公司淨利 − 特別股股利（兩者都沒有＝null）
  const niCommon = (() => {
    const d = { c: cur(IS.net_income_to_common), p: pri(IS.net_income_to_common) };
    if (d.c !== null) return d;
    const pd = { c: cur(IS.preferred_dividends), p: pri(IS.preferred_dividends) };
    if (pd.c === null || niP.c === null) return null;
    return { c: niP.c - Math.abs(pd.c), p: niP.p !== null && pd.p !== null ? niP.p - Math.abs(pd.p) : null };
  })();
  const other = { c: cur(IS.other_operating_net) ?? 0, p: pri(IS.other_operating_net) ?? 0 };
  const opexTotal = { c: cur(IS.operating_expenses_total), p: pri(IS.operating_expenses_total) };

  // ── 3. 毛利：原文有就用；沒有但有營業成本 → 依損益表科目計算並註明（rules/derivations.json）
  let gp = { c: cur(IS.gross_profit), p: pri(IS.gross_profit) };
  if (gp.c !== null && cogs.c !== null) {
    const d = rev.c - cogs.c - gp.c;
    const okGP = Math.abs(d) <= tol(2);
    // 不符時找找看：把哪幾列費用併進營業成本就相符（公司把多列成本分開列示的情況）
    let suggest = null;
    if (!okGP && gpMode !== "custom_cogs") {
      const S = smallestSubset(itemsBase, (sub) => near(rev.c - cogsBase.c - sub.reduce((a, it) => a + it.c, 0), gp.c, tol(sub.length + 2))
        && (gp.p === null || cogsBase.p === null || rev.p === null || sub.some((it) => it.p === null) || near(rev.p - cogsBase.p - sub.reduce((a, it) => a + it.p, 0), gp.p, tol(sub.length + 2))));
      if (S && S.length) suggest = { patch: { calc: { gross_profit: "custom_cogs", cogs_items: ["cost_of_revenue", ...S.map((it) => it.key)] } },
        text: `把「${S.map((it) => it.nm.zh).join("、")}」併進營業成本，毛利就與原文相符：可能是這家公司的毛利算式不同` };
    }
    add("gross_profit_identity", `毛利＝營收−營業成本${cogsNote ? `（公司算式：${cogsNote}）` : ""}`, okGP ? "pass" : "fail", `差 ${d}`, suggest);
  } else if (gp.c === null && cogs.c !== null) {
    gp = { c: rev.c - cogs.c, p: rev.p !== null && cogs.p !== null ? rev.p - cogs.p : null };
    derivable.push({ id: "derived_gross_profit", name: "毛利", formula: "營收 − 營業成本" });
    derived.push("毛利（營收−營業成本）");
    add("gross_profit_identity", "毛利＝營收−營業成本", "skip", "原文未列毛利，依損益表科目計算");
  } else {
    add("gross_profit_identity", "毛利＝營收−營業成本", "skip", "公司沒有營業成本／毛利（例如金融業）");
  }

  // 圖上使用的毛利：毛利勾稽不符且使用者確認原文如此時，不畫毛利
  const gpHidden = overridden("gross_profit_identity");
  const gpShown = gpHidden ? { c: null, p: null } : gp;

  // ── 3a. 圖上用的毛利（公司規範 calc.gross_profit）：auto、custom_cogs＝上面的結果
  let chartGp = gpShown;
  const dropDerived = (prefix) => { for (let i = derived.length - 1; i >= 0; i--) if (derived[i].startsWith(prefix)) derived.splice(i, 1); };
  if (gpMode === "stated") {
    chartGp = gpHidden ? { c: null, p: null } : { c: cur(IS.gross_profit), p: pri(IS.gross_profit) };
    dropDerived("毛利");
  } else if (gpMode === "revenue_minus_cogs") {
    if (cogs.c !== null) {
      chartGp = { c: rev.c - cogs.c, p: rev.p !== null && cogs.p !== null ? rev.p - cogs.p : null };
      dropDerived("毛利"); derived.unshift("毛利（營收−營業成本）");
    } else ruleIssues.push("毛利算式「營收 − 營業成本」：本季沒有營業成本，改用通用算式");
  } else if (gpMode === "none") {
    chartGp = { c: null, p: null };
    dropDerived("毛利");
  }

  // ── 4. 營業利益勾稽
  const sumItems = (k) => items.reduce((a, it) => a + (it[k] ?? 0), 0);
  for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
    if (oi[k] === null || rev[k] === null) continue;
    const opex = opexTotal[k] ?? sumItems(k);
    const base = (gp[k] ?? rev[k]);
    const calc = base - opex + (other[k] || 0);
    const d = calc - oi[k];
    add(`operating_income_identity_${k}`, `${lab}：營業利益＝${gp[k] !== null ? "毛利" : "營收"}−營業費用`, Math.abs(d) <= tol(items.length + 2) ? "pass" : "fail", `計算 ${calc}，原文 ${oi[k]}，差 ${d}`);
  }

  // ── 5. 業外：原文沒有合計 → 稅前−營業利益，依損益表科目計算並註明
  let nonop = { c: cur(IS.non_operating_net), p: pri(IS.non_operating_net) };
  if (nonop.c === null && pretax.c !== null && oi.c !== null) {
    nonop = { c: pretax.c - oi.c, p: pretax.p !== null && oi.p !== null ? pretax.p - oi.p : null };
    derivable.push({ id: "derived_non_operating", name: "業外收支淨額", formula: "稅前淨利 − 營業利益" });
    derived.push("業外收支淨額（稅前淨利−營業利益）");
    add("pretax_identity", "稅前淨利＝營業利益＋業外", "skip", "原文未列業外合計，依損益表科目計算");
  } else if (nonop.c !== null) {
    const d = oi.c + nonop.c - pretax.c;
    add("pretax_identity", "稅前淨利＝營業利益＋業外", Math.abs(d) <= tol(2) ? "pass" : "fail", `差 ${d}`);
  }

  // ── 6. 所得稅正負號：依勾稽判斷公司的呈現方式（有的公司以括號列示費用）
  const taxRaw = { c: cur(IS.income_tax), p: pri(IS.income_tax) };
  let tax = { c: null, p: null };
  for (const k of ["c", "p"]) {
    if (taxRaw[k] === null || pretax[k] === null || ni[k] === null) continue;
    if (Math.abs(pretax[k] - taxRaw[k] - ni[k]) <= tol(2)) tax[k] = taxRaw[k];        // 正數＝費用
    else if (Math.abs(pretax[k] + taxRaw[k] - ni[k]) <= tol(2)) tax[k] = -taxRaw[k];  // 原文以負數列示費用
  }
  add("net_income_identity", "淨利＝稅前淨利−所得稅", tax.c !== null ? "pass" : "fail",
    tax.c !== null && taxRaw.c < 0 ? "公司以負數（括號）列示所得稅費用，已自動轉換" : tax.c === null ? "兩種正負號解讀都對不上" : "");

  // ── 7. EPS：口徑依市場規則（美股稀釋、台股基本；其他市場依新聞稿標題），AI 在 meta.eps_basis 標示
  const ruleBasis = profile.defaults.eps_basis || null;
  const epsBasis = m.eps_basis || ruleBasis || "diluted";
  const EPS_ZH = { diluted: "稀釋", basic: "基本" };
  const epsZh = `${EPS_ZH[epsBasis]} EPS`;
  const epsPair = epsBasis === "basic" ? IS.eps_basic : IS.eps_diluted;
  const shPair = epsBasis === "basic" ? IS.shares_basic : IS.shares_diluted;
  if (!m.eps_basis) add("eps_basis", "EPS 口徑", "warn", `AI 沒有標示 meta.eps_basis，暫依市場規則視為${EPS_ZH[epsBasis]} EPS`);
  else if (ruleBasis && m.eps_basis !== ruleBasis) add("eps_basis", "EPS 口徑符合市場規則", "fail", `市場規則抽${EPS_ZH[ruleBasis]} EPS，AI 標示為${EPS_ZH[m.eps_basis]} EPS`);
  else add("eps_basis", "EPS 口徑", "pass", `${epsZh}${ruleBasis ? "" : "（依新聞稿標題）"}`);
  const eps = { c: cur(epsPair), p: pri(epsPair) };
  if (eps.c === null || eps.p === null) add("eps_present", `${epsZh}本季與去年同期都有數字`, "fail", `缺少${eps.c === null ? "本季" : ""}${eps.c === null && eps.p === null ? "與" : ""}${eps.p === null ? "去年同期" : ""}的 ${epsBasis === "basic" ? "eps_basic" : "eps_diluted"}`);
  // 同一項目（本季、去年同期）用相同位數：依原文位數，取較多的
  const epsDec = itemDecimals([[epsPair?.current, "value"], [epsPair?.prior_year, "value"]]);

  // EPS 勾稽（股數與金額單位可能不同）：用來檢查抽取是否正確
  //   分子依公司算式（calc.eps_numerator）：預設歸屬母公司淨利；有特別股的公司用歸屬普通股股東淨利
  const shPow = UNIT_POWER[m.share_unit] ?? srcPow;
  const shZh = `${EPS_ZH[epsBasis]}股數`;
  let epsNum = niP, epsNumZh = "淨利";
  if (rules.calc.eps_numerator === "common") {
    if (niCommon) { epsNum = niCommon; epsNumZh = "歸屬普通股股東淨利"; }
    else ruleIssues.push("EPS 的分子「歸屬普通股股東淨利」：本季沒有這一列，也沒有特別股股利，改用通用算式");
  }
  const perShare = (numr, k) => {
    const sh = k === "c" ? cur(shPair) : pri(shPair);
    return numr && numr[k] !== null && sh ? (numr[k] * Math.pow(10, srcPow)) / (sh * Math.pow(10, shPow)) : null;
  };
  const epsCalc = (k) => perShare(epsNum, k);
  for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
    const e = epsCalc(k);
    if (e === null || eps[k] === null) { add(`eps_identity_${k}`, `${lab}：EPS≈${epsNumZh}÷${shZh}`, "skip"); continue; }
    const okE = Math.abs(e - eps[k]) <= 0.01;
    // 不符時：改用歸屬普通股股東淨利就相符 → 建議採用這家公司的 EPS 算式
    let suggest = null;
    if (!okE && epsNum === niP && niCommon) {
      const e2 = perShare(niCommon, k);
      if (e2 !== null && Math.abs(e2 - eps[k]) <= 0.01) suggest = { patch: { calc: { eps_numerator: "common" } },
        text: `改用歸屬普通股股東淨利（扣除特別股股利）計算為 ${e2.toFixed(4)}，與原文相符：可能是這家公司的 EPS 算式不同` };
    }
    add(`eps_identity_${k}`, `${lab}：EPS≈${epsNumZh}÷${shZh}`, okE ? "pass" : "fail", `計算 ${e.toFixed(4)}，原文 ${eps[k]}`, suggest);
  }

  // ── 8. 營收拆分加總（同時偵測單位不一致）
  //   公司算式 revenue_items.subtotal：小計列（AI 把小計和明細一起抽進來時）不計入加總、不畫
  const subtotal = new Set(rules.revenue_items.subtotal);
  for (const k of subtotal) if (![...(fs.segments || []), ...(fs.geographies || [])].some((x) => x.key === k)) ruleIssues.push(`小計列：本季找不到「${k}」`);
  const revRows = (list) => (list || []).filter((s) => s.revenue && !subtotal.has(s.key));
  function sumCheck(list, name) {
    const zh = name === "segments" ? "部門" : "地區";
    if (!list || !list.length) return add(`${name}_sum`, `${zh}加總＝營收`, "skip", "無資料");
    const items2 = revRows(list);
    if (!items2.length) return add(`${name}_sum`, "拆分加總", "skip", "只有百分比");
    const val = (x, k) => (k === "c" ? cur(x.revenue) : pri(x.revenue)) ?? 0;
    const subNote = list.some((x) => subtotal.has(x.key)) ? "（公司算式：不含小計列）" : "";
    for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
      const s = items2.reduce((a, x) => a + val(x, k), 0);
      const target = rev[k];
      if (target === null) continue;
      const ratio = s / target;
      let status = Math.abs(s - target) <= tol(items2.length) ? "pass" : "fail";
      let detail = `加總 ${s}，營收 ${target}`;
      if (status === "fail" && (Math.abs(ratio - 0.001) < 0.0002 || Math.abs(ratio - 1000) < 200)) detail += "｜疑似單位不一致（相差約 1000 倍）";
      // 不符時找找看：扣掉哪幾列（小計）就相符 → 建議把它們標為小計列
      let suggest = null;
      if (status === "fail" && s > target) {
        const S = smallestSubset(items2, (sub) => ["c", "p"].every((kk) => rev[kk] === null || near(items2.reduce((a, x) => a + val(x, kk), 0) - sub.reduce((a, x) => a + val(x, kk), 0), rev[kk], tol(items2.length))), 3);
        if (S) suggest = { patch: { revenue_items: { subtotal: [...subtotal, ...S.map((x) => x.key)] } },
          text: `扣掉「${S.map((x) => x.label_source).join("、")}」後加總就等於營收：這幾列可能是小計（AI 把小計和明細一起抽進來了），標為小計列後不計入加總、不畫` };
      }
      add(`${name}_sum_${k}`, `${lab}：${zh}加總＝營收${subNote}`, status, detail, suggest);
    }
  }
  sumCheck(fs.segments, "segments");
  sumCheck(fs.geographies, "geographies");

  // ── 9. 指標
  const M = {};
  M.revenue_yoy = yoy(rev.c, rev.p);
  M.gross_margin = pctOf(chartGp.c, rev.c); M.gross_margin_p = pctOf(chartGp.p, rev.p);
  M.operating_margin = pctOf(oi.c, rev.c); M.operating_margin_p = pctOf(oi.p, rev.p);
  M.net_margin = pctOf(niP.c, rev.c); M.net_margin_p = pctOf(niP.p, rev.p);
  M.gross_margin_change_pp_yoy = M.gross_margin !== null && M.gross_margin_p !== null ? M.gross_margin - M.gross_margin_p : null;
  M.operating_margin_change_pp_yoy = M.operating_margin !== null && M.operating_margin_p !== null ? M.operating_margin - M.operating_margin_p : null;
  M.net_margin_change_pp_yoy = M.net_margin !== null && M.net_margin_p !== null ? M.net_margin - M.net_margin_p : null;
  // EPS 年增率（rules/derivations.json）：公司有寫、且與公布 EPS 一致時用公司的數字（見第 10 步）；
  // 否則用公布的 EPS 計算，不用淨利 ÷ 股數重算
  M.eps_yoy = yoy(eps.c, eps.p);
  M.eps_yoy_decimals = 1;
  M.eps_yoy_source = "computed";
  M.operating_income_yoy = yoy(oi.c, oi.p);
  M.net_income_yoy = yoy(niP.c, niP.p);

  // 季變動：原文有上一季欄位（prior_quarter）或歷史存檔時才算
  const last = history.length ? history[history.length - 1] : null;
  const pq = (pair) => num(pair?.prior_quarter);
  const revQ = pq(IS.revenue), oiQ = pq(IS.operating_income), niQ = pq(IS.net_income_to_parent) ?? pq(IS.net_income);
  if (gpMode !== "custom_cogs" || cogs === cogsBase) cogsQ = pq(IS.cost_of_revenue) ?? (fs.operating_expense_items || []).filter((it) => cogsAliases.includes(norm(it.label_source))).map((it) => pq(it.amount))[0] ?? null;
  const gpQ = gpMode === "none" || gpHidden ? null
    : gpMode === "stated" ? pq(IS.gross_profit)
    : gpMode === "revenue_minus_cogs" ? (revQ !== null && cogsQ !== null ? revQ - Math.abs(cogsQ) : null)
    : pq(IS.gross_profit) ?? (revQ !== null && cogsQ !== null ? revQ - Math.abs(cogsQ) : null);
  M.gross_margin_q = pctOf(gpQ, revQ); M.operating_margin_q = pctOf(oiQ, revQ); M.net_margin_q = pctOf(niQ, revQ);
  M.gross_margin_change_pp_qoq = M.gross_margin !== null && M.gross_margin_q !== null ? M.gross_margin - M.gross_margin_q : null;
  M.operating_margin_change_pp_qoq = M.operating_margin !== null && M.operating_margin_q !== null ? M.operating_margin - M.operating_margin_q : null;
  M.net_margin_change_pp_qoq = M.net_margin !== null && M.net_margin_q !== null ? M.net_margin - M.net_margin_q : null;
  M.revenue_qoq = yoy(rev.c, revQ);
  M.margin_8q_extreme = null; // 需要 7 季歷史存檔，目前工具尚未讀取 history/

  // 拆分指標
  function breakdown(list, listName) {
    const pre = listName === "segments" ? "seg" : "geo";
    if (!list || !list.length) return null;
    const rows = revRows(list).map((s) => {
      const c = cur(s.revenue), p = pri(s.revenue);
      const meta = (company.geographies || []).concat(company.segments || []).find((x) => x.key === s.key);
      // 調節項目：列在各部門小計之外、但計入總營收的項目。依序採用：公司規範 → 公司設定檔 → AI 標示。不畫進柱子，改放註腳
      const ruled = rules.revenue_items.reconciling[s.key];
      return { key: s.key, nm: nameOf(s, `${pre}:${s.key}`, ctx, meta?.label_zh), c, p, share: pctOf(c, rev.c), share_p: pctOf(p, rev.p), yoy: yoy(c, p), shown: yoyShown(c, p),
        reconciling: typeof ruled === "boolean" ? ruled : !!(meta?.reconciling ?? s.reconciling), base: !!(meta?.reconciling ?? s.reconciling), aiReconciling: !!s.reconciling, ruled: typeof ruled === "boolean" };
    });
    const main = rows.filter((r) => !r.reconciling);
    if (!main.length) return null;
    return {
      rows,
      maxShareChange: Math.max(...main.map((r) => Math.abs((r.share ?? 0) - (r.share_p ?? 0)))),
      maxYoyGap: Math.max(...main.map((r) => Math.abs((r.yoy ?? 0) - (M.revenue_yoy ?? 0)))),
    };
  }
  const sumOv = (n) => overridden(`${n}_sum_c`) || overridden(`${n}_sum_p`);
  const seg = sumOv("segments") ? null : breakdown(fs.segments, "segments");
  const geo = sumOv("geographies") ? null : breakdown(fs.geographies, "geographies");
  if (sumOv("segments") || sumOv("geographies")) dropped.push("營收拆解卡（拆分加總與營收不符，使用者確認原文如此）");
  M.segment_share_change_pp_yoy = seg ? seg.maxShareChange : null;
  M.segment_yoy_gap_pp = seg ? seg.maxYoyGap : null;
  M.geo_share_change_pp_yoy = geo ? geo.maxShareChange : null;
  M.geo_yoy_gap_pp = geo ? geo.maxYoyGap : null;

  M.non_operating_share_of_net_income = nonop.c !== null && niP.c ? Math.abs(nonop.c) / Math.abs(niP.c) : null;
  M.notable_items_share_of_net_income = (fs.notable_items || []).length && niP.c
    ? fs.notable_items.reduce((a, x) => a + Math.abs(num(x.amount) || 0), 0) / Math.abs(niP.c) : null;

  // 現金流量：本季與去年同期必須同一種期間
  const cf = fs.cash_flow || {};
  const ptype = (pair) => [pair?.current?.period_type || "quarter", pair?.prior_year?.period_type || "quarter"];
  const ocf = { c: cur(cf.operating_cash_flow), p: pri(cf.operating_cash_flow) };
  const capex = { c: cur(cf.capex) === null ? null : Math.abs(cur(cf.capex)), p: pri(cf.capex) === null ? null : Math.abs(pri(cf.capex)) };
  const cr = fs.capital_return || {};
  const buy = { c: cur(cr.buybacks) === null ? null : Math.abs(cur(cr.buybacks)), p: pri(cr.buybacks) === null ? null : Math.abs(pri(cr.buybacks)) };
  const div = { c: cur(cr.dividends_paid) === null ? null : Math.abs(cur(cr.dividends_paid)), p: pri(cr.dividends_paid) === null ? null : Math.abs(pri(cr.dividends_paid)) };
  const cfTypes = [ptype(cf.operating_cash_flow), ptype(cf.capex), ptype(cr.buybacks)].flat().filter(Boolean);
  const cfIsQuarter = cfTypes.every((t) => t === "quarter");
  if (ocf.c !== null || capex.c !== null) {
    add("cash_flow_period", "現金流量為單季數字", cfIsQuarter ? "pass" : "warn", cfIsQuarter ? "" : "含年初至今累計數；若原文有單季欄位，應改抽單季");
  }
  const cfUse = cfIsQuarter;
  M.capex_yoy = cfUse ? yoy(capex.c, capex.p) : null;
  M.capital_return_yoy = cfUse && (buy.c !== null || div.c !== null) ? yoy((buy.c || 0) + (div.c || 0), (buy.p || 0) + (div.p || 0)) : null;
  M.buybacks_yoy = cfUse ? yoy(buy.c, buy.p) : null;
  M.new_buyback_authorization = !!cr.new_buyback_authorization;
  const fcfStated = cur(cf.free_cash_flow_stated);
  // 圖上用的自由現金流（公司算式 calc.free_cash_flow）：預設只用公司公布的數字
  let fcfShown = fcfStated, fcfNote = fcfStated !== null ? "自由現金流為公司公布的非 GAAP 數字。" : "";
  if (rules.calc.free_cash_flow === "ocf_minus_capex") {
    if (ocf.c !== null && capex.c !== null) { fcfShown = ocf.c - capex.c; fcfNote = "自由現金流依營業現金流−資本支出計算。"; }
    else ruleIssues.push("自由現金流算式「營業現金流 − 資本支出」：本季缺營業現金流或資本支出，改用通用算式");
  }
  if (fcfStated !== null && ocf.c !== null && capex.c !== null) {
    const d = ocf.c - capex.c - fcfStated;
    add("fcf_identity", "自由現金流＝營業現金流−資本支出", Math.abs(d) <= tol(2) ? "pass" : "warn", `差 ${d}（公司定義可能不同）`);
  }

  // ── 10. 公司自己寫出的 EPS 年增率：與公布 EPS 一致時圖卡採用（其他比率在「圖卡數字核對」比對）
  const statedMap = { revenue_yoy: M.revenue_yoy, operating_margin: M.operating_margin, gross_margin: M.gross_margin, net_margin: M.net_margin, eps_yoy: M.eps_yoy, revenue_qoq: M.revenue_qoq };
  // 公布的 EPS 已四捨五入，公司自己寫的 EPS 年增率可能用未四捨五入的數字算：容許 EPS 尾數 ±0.5 個最小單位造成的差異
  const epsYoyRange = () => {
    if (eps.c === null || eps.p === null) return null;
    const h = 0.5 * Math.pow(10, -epsDec);
    const vs = [[eps.c - h, eps.p - h], [eps.c - h, eps.p + h], [eps.c + h, eps.p - h], [eps.c + h, eps.p + h]].map(([a, b]) => yoy(a, b)).filter((x) => x !== null);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : null;
  };
  const epsStatedOk = []; // 通過檢查的公司公布 EPS 年增率
  const epsYoyNps = yoy(epsCalc("c"), epsCalc("p")); // 用「EPS 的分子 ÷ 股數」（四捨五入前）算的年增率
  const npsRule = rules.calc.eps_yoy === "net_income_per_share";
  for (const s of fs.stated_metrics || []) {
    if (!(s.metric in statedMap) || statedMap[s.metric] === null) continue;
    let calc = statedMap[s.metric];
    const allow = 0.5 * Math.pow(10, -decOf(s, "value")) + 0.05;
    // EPS 年增率：公司算式為「分子 ÷ 股數」時直接比對；否則比對公布 EPS 四捨五入可能的範圍
    if (s.metric === "eps_yoy" && npsRule && epsYoyNps !== null) calc = epsYoyNps;
    const rg = s.metric === "eps_yoy" && !(npsRule && epsYoyNps !== null) ? epsYoyRange() : null;
    const ok = rg ? s.value >= rg[0] - allow && s.value <= rg[1] + allow : Math.abs(calc - s.value) <= allow;
    if (s.metric === "eps_yoy" && ok && s.unit === "percent") epsStatedOk.push(s);
    // 公司寫的比率與工具計算的比對，移到「圖卡數字核對」（依四捨五入／定義不同／抓錯分類），不列在第三層
  }
  // 公司有寫 EPS 年增率、且與公布 EPS 一致 → 圖卡用公司的數字（位數依原文；表格與內文各寫一次時用位數較多的）
  if (epsStatedOk.length) {
    const best = epsStatedOk.reduce((a, x) => (decOf(x, "value") > decOf(a, "value") ? x : a));
    M.eps_yoy = best.value;
    M.eps_yoy_decimals = decOf(best, "value");
    M.eps_yoy_source = "stated";
  }
  // 公司算式可改 EPS 年增率的算法（預設 stated_first：上面的結果）
  let epsNote = "";
  if (rules.calc.eps_yoy === "reported_eps") { M.eps_yoy = yoy(eps.c, eps.p); M.eps_yoy_decimals = 1; M.eps_yoy_source = "computed"; }
  else if (rules.calc.eps_yoy === "net_income_per_share") {
    const v = yoy(epsCalc("c"), epsCalc("p"));
    if (v !== null) { M.eps_yoy = v; M.eps_yoy_decimals = 1; M.eps_yoy_source = "net_income_per_share"; epsNote = `EPS 年增率依${epsNumZh}÷${shZh}計算。`; }
    else ruleIssues.push("EPS 年增率算式「分子 ÷ 股數」：本季缺股數，改用通用算式");
  }
  if (M.eps_yoy !== null) add("eps_yoy_source", "EPS 年增率的來源", "pass",
    M.eps_yoy_source === "stated" ? `採用公司公布的 ${fixed(M.eps_yoy, M.eps_yoy_decimals)}%（與公布 EPS 一致）` : M.eps_yoy_source === "net_income_per_share" ? `依公司算式，用${epsNumZh} ÷ ${shZh}計算為 ${fmt1(M.eps_yoy)}%` : `${rules.calc.eps_yoy === "reported_eps" ? "依公司算式" : "公司未寫出可採用的 EPS 年增率，"}依公布 EPS 計算為 ${fmt1(M.eps_yoy)}%`);

  // ── 11. 合理範圍
  for (const [k, lab] of [["gross_margin", "毛利率"], ["operating_margin", "營益率"], ["net_margin", "淨利率"]]) {
    const v = M[k];
    if (v === null) continue;
    add(`range_${k}`, `${lab}在合理範圍`, v > -100 && v < 100 ? "pass" : "fail", `${v.toFixed(1)}%`);
  }
  if (M.revenue_yoy !== null) add("yoy_outlier", "營收年增率未超過 ±100%", Math.abs(M.revenue_yoy) <= 100 ? "pass" : "warn", `${M.revenue_yoy.toFixed(1)}%`);

  // ── 12. 財測單位：與報表單位比對量級
  const g = fs.guidance_next;
  let guidanceScale = Math.pow(10, srcPow);
  if (g && g.monetary_unit) {
    guidanceScale = Math.pow(10, UNIT_POWER[g.monetary_unit]);
    add("guidance_unit", "財測金額單位", "pass", g.monetary_unit === m.monetary_unit ? `與報表相同（${g.monetary_unit}）` : `財測單位 ${g.monetary_unit}、報表單位 ${m.monetary_unit}，已換算（單位本身在第二層核對）`);
  } else if (g && g.items.length) {
    const gRev = g.items.find((x) => x.metric === "revenue");
    const gv = gRev ? (gRev.point ?? (gRev.low + gRev.high) / 2) : null;
    if (gv && rev.c) {
      const ratio = rev.c / gv; // 正常約 1；差 1000 倍表示財測用較大單位
      const powDiff = Math.round(Math.log10(ratio) / 3) * 3;
      if (powDiff !== 0) {
        guidanceScale = Math.pow(10, srcPow + powDiff);
        add("guidance_unit", "財測金額單位與報表一致", "warn", `AI 沒有標示財測單位；財測金額約為報表的 1/${Math.pow(10, powDiff)}，推定為 ${Object.keys(UNIT_POWER).find((u) => UNIT_POWER[u] === srcPow + powDiff)}。請在第二層「財測金額單位」照原文填入`);
      } else add("guidance_unit", "財測金額單位與報表一致", "pass");
    }
  }

  // ── 12a. 內文寫出的營收金額（例如「$12.9B」）與報表營收換算後一致：獨立驗證金額單位
  for (const sm of (fs.stated_metrics || []).filter((x) => x.metric === "revenue_amount" && UNIT_POWER[x.unit] !== undefined)) {
    const ratio = (sm.value * Math.pow(10, UNIT_POWER[sm.unit])) / (rev.c * Math.pow(10, srcPow));
    add(`revenue_amount_${sm.value}`, `內文營收金額 ${sm.value} ${sm.unit} 與報表一致`, Math.abs(ratio - 1) <= 0.05 ? "pass" : "fail",
      Math.abs(ratio - 1) <= 0.05 ? "" : `報表營收換算後為內文的 ${(1 / ratio).toPrecision(3)} 倍：金額單位可能有誤`);
  }

  // ── 12b. 會計期間與期末日一致（依公司財年；沒有公司設定時視為 12 月底結束）
  {
    const pe = /^(\d{4})-(\d{2})-\d{2}$/.exec(m.period_end || "");
    const cal = fiscalToCalendar(m.fiscal_period, company.fiscal_year_end_month || 12);
    if (pe) {
      const expect = `${pe[1]}Q${Math.ceil(+pe[2] / 3)}`;
      const okP = cal === expect;
      add("fiscal_period_vs_end", "會計期間與期末日一致", okP ? "pass" : company.fiscal_year_end_month ? "fail" : "warn",
        okP ? `${m.fiscal_period}＝${expect}` : `${m.fiscal_period} 換算為 ${cal}，但期末日 ${m.period_end} 屬於 ${expect}${company.fiscal_year_end_month ? "" : "（沒有公司設定檔，以 12 月底為財年結束推算）"}`);
    }
  }
  // ── 12c. 財測營收與本季營收量級一致：兩個獨立標示的單位互相驗證，抓「單位整批改錯」
  if (g && g.items.length) {
    const gRev = g.items.find((x) => x.metric === "revenue");
    const gv = gRev ? (gRev.point ?? (gRev.low + gRev.high) / 2) : null;
    if (gv && rev.c) {
      const ratio = (gv * guidanceScale) / (rev.c * Math.pow(10, srcPow));
      add("guidance_magnitude", "下季財測營收與本季營收量級一致", ratio > 0.5 && ratio < 2 ? "pass" : "fail",
        `財測營收為本季營收的 ${ratio >= 10 || ratio < 0.1 ? ratio.toExponential(0) : ratio.toFixed(2)} 倍${ratio > 0.5 && ratio < 2 ? "" : "：報表或財測的金額單位可能有誤"}`);
    }
  }

  // ── 13. AI 提出的疑慮：每一條都要人工處理
  if ((fs.ambiguities || []).length) {
    add("ambiguities", "AI 提出的疑慮", "warn", `${fs.ambiguities.length} 條，需逐條確認`);
  }

  // ── 14. 圖卡要用的數字是否完整：資料不完整（缺數字、加總不符）的圖卡不產出；條件圖卡由下一順位遞補
  const disp = (v) => toDisp(v);
  const r2 = (v) => Math.round(v * 100) / 100;
  const missingOf = (pairs) => pairs.filter(([, v]) => v === null || v === undefined).map(([n]) => n);
  // B：一般部門與調節項目兩期都有數字，且「柱內各段＋註腳項目＝柱頂總額」（依圖上 2 位小數，容許四捨五入誤差）
  const bCheck = (bd) => {
    if (!bd) return "沒有部門或地區資料";
    const miss = bd.rows.filter((r) => r.c === null || r.p === null).map((r) => r.nm.zh);
    if (miss.length) return `${miss.join("、")}缺本季或去年同期數字`;
    if (rev.c === null || rev.p === null) return "缺營收";
    for (const k of ["p", "c"]) {
      const d = bd.rows.reduce((a, r) => a + r2(disp(r[k])), 0) - r2(disp(rev[k]));
      if (Math.abs(d) > 0.005 * (bd.rows.length + 1) + 1e-9) return `柱內加總＋註腳與總營收差 ${d.toFixed(2)}`;
    }
    return null;
  };
  const segWhy = bCheck(seg), geoWhy = bCheck(geo);
  const dMiss = missingOf([["營益率", M.operating_margin], ["去年同期營益率", M.operating_margin_p], ["淨利率", M.net_margin], ["去年同期淨利率", M.net_margin_p]]);
  const gMiss = [...(cfIsQuarter ? [] : ["單季現金流量（目前是累計數）"]), ...missingOf([["營業現金流", ocf.c], ["資本支出", capex.c]])];
  const available = {
    B: !segWhy || !geoWhy,
    D: !dMiss.length,
    G: !gMiss.length,
  };
  const whyNot = {
    B: [seg && `部門：${segWhy}`, geo && `地區：${geoWhy}`].filter(Boolean).join("；") || "沒有部門或地區資料",
    D: `缺${dMiss.join("、")}`,
    G: `缺${gMiss.join("、")}`,
  };

  // ── 15. 選圖（rules/triggers.json）：只從資料完整的圖卡中選
  // E（對比預期）、F（營運指標）、I（同業）的規則已寫好，但圖卡資料尚未接上，觸發了也不佔用張數。
  const BUILDABLE = ["B", "D", "G"];
  const selection = selectModules(M, triggers, { hasGuidancePrev: !!last?.guidance_next, consensus: fs.consensus, peers: false, buildable: BUILDABLE, available });
  for (const c of selection.incompleteFired || []) incomplete.push({ card: c, reason: whyNot[c] || "資料不完整" });

  // ── 16. 圖卡 spec
  const period = fiscalToCalendar(m.fiscal_period, company.fiscal_year_end_month || 12);
  const header = { ticker: m.ticker, period, label: "財報快報" };
  const docName = company.source_doc_name_zh || "財報新聞稿";
  const baseSource = `資料來源：${company.company_name_zh || m.company_name} ${period} ${docName}（${m.report_date}）`;
  // 頁尾附註（spec.notes）：頁尾最多兩行，放不下時依優先順序（p 越小越優先）保留，其餘列在「圖卡數字核對」請寫進貼文
  //   p1 計算方式與公司算式；p2 口徑（淨利口徑、與新聞稿定義不同）；p3 調節項目
  //   附註只寫名稱，不寫主詞（帳號署名已在右下角），例如「毛利、業外收支淨額依損益表科目計算」；公式寫在 rules/derivations.json 與核對畫面
  const src = `${baseSource}。`;
  const derivedNote = (list) => (list.length ? [{ text: `${list.map((d) => d.replace(/（.*）$/, "")).join("、")}依損益表科目計算。`, p: 1 }] : []);
  const cNotes = cogsNote ? [{ text: `${cogsNote}。`, p: 1 }] : [];
  // 淨利口徑：圖上的淨利與 EPS 的分子不同（且差異不只是四捨五入）時才註明；不寫差額（避免連串四捨五入造成的小差異被放大）
  const r2d = (v) => (v === null ? null : Math.round(disp(v) * 100) / 100);
  const niBasisNote = epsNum !== niP && epsNum && r2d(epsNum.c) !== r2d(niP.c)
    ? `淨利為${niP.c === ni.c ? "損益表淨利" : "歸屬母公司淨利"}；EPS 以歸屬普通股股東之淨利計算。` : "";

  const cards = [];
  const name = company.company_name_zh || m.company_name;
  // A1：營收、營益率、EPS 都要有本季與去年同期
  const a1Miss = missingOf([["營收", rev.c], ["去年同期營收", rev.p], ["營業利益", oi.c], ["去年同期營業利益", oi.p], [epsZh, eps.c], [`去年同期${epsZh}`, eps.p]]);
  if (a1Miss.length) incomplete.push({ card: "A1", reason: `缺${a1Miss.join("、")}` });
  else cards.push({
    id: "A1", template: "T1", header, source: src, notes: epsNote ? [{ text: epsNote, p: 1 }] : [],
    body: {
      ticker: m.ticker, company: name, period,
      headline: `營收 ${unitText.split(" ")[0]} ${fmt2(disp(rev.c))}${DISPLAY_LABEL[dispUnit]}，年增 ${yoyText(yoyShown(rev.c, rev.p))}`,
      kpis: [
        { label: "營收", unit: unitText, value: disp(rev.c), kind: "amount", delta: { value: yoyShown(rev.c, rev.p), kind: "pct", label: "年增" }, note: `去年同期 ${fmt2(disp(rev.p))}` },
        { label: "營益率", unit: "%", value: M.operating_margin, kind: "pct", delta: { value: M.operating_margin_change_pp_yoy, kind: "pp", label: "年變動" }, note: `去年同期 ${fmt1(M.operating_margin_p)}%` },
        // EPS 是原文直接抽取、未經換算的數字：位數依原文（本季與去年同期取較多位，不足補 0）
        { label: epsZh, unit: profile.defaults.display_currency, value: eps.c, kind: "perShare", decimals: epsDec, delta: { value: yoyShown(eps.c, eps.p, M.eps_yoy), kind: "pct", label: "年增", decimals: M.eps_yoy_decimals }, note: `去年同期 ${fixed(eps.p, epsDec)}` },
      ],
    },
  });

  // C：營收、營業利益、費用；畫到淨利時還要淨利、所得稅、業外
  const highlight = triggers.modules.C.annotations[0];
  const hl = evalCond(highlight.when, M).value;
  const stopAtOI = overridden("pretax_identity") || overridden("net_income_identity");
  if (stopAtOI) dropped.push("損益流向圖的業外、所得稅、淨利段（勾稽不符，使用者確認原文如此）");
  const cMiss = [...missingOf([["營收", rev.c], ["營業利益", oi.c]]), ...(cogs.c === null && !items.length ? ["營業成本或費用"] : []),
    ...(stopAtOI ? [] : missingOf([["淨利", niP.c], ["所得稅", tax.c], ["業外收支", nonop.c]]))];
  if (overridden("operating_income_identity_c")) dropped.push("損益流向卡（營業利益與各項費用對不起來，使用者確認原文如此）");
  else if (cMiss.length) incomplete.push({ card: "C", reason: `缺${cMiss.join("、")}` });
  else cards.push({
    id: "C", template: "T4", header: { ...header, label: "損益流向" },
    source: src, notes: [...derivedNote(stopAtOI ? derived.filter((d) => !d.startsWith("業外")) : derived), ...cNotes],
    body: {
      unit: unitText,
      revenue: disp(rev.c), cogs: cogs.c === null ? 0 : disp(cogs.c), grossProfit: chartGp.c === null ? null : disp(chartGp.c),
      stopAt: stopAtOI ? "operating_income" : undefined,
      showPct: true, // 每個節點標佔營收 %（業主要求）
      opex: items.map((it) => ({ name: useName(it.nm), value: disp(it.c) })),
      otherOperating: disp(other.c || 0), operatingIncome: disp(oi.c),
      nonOperating: disp(nonop.c || 0), tax: disp(tax.c ?? 0), netIncome: disp(niP.c),
      margins: { gross: chartGp.c !== null && cogs.c !== null ? M.gross_margin : undefined, operating: M.operating_margin, net: M.net_margin },
      // 圖下註記：公司標示的一次性項目（＊）；淨利口徑（條件觸發）
      note: hl && fs.notable_items?.length ? fs.notable_items.map((x) => `${useName(nameOf(x, `notable:${x.label_source}`, ctx))} ${fmt2(disp(num(x.amount)))}`).join("；") : undefined,
      footnote: stopAtOI ? undefined : niBasisNote || undefined,
    },
  });

  // 條件模組
  for (const code of selection.chosen) {
    const base = code.split(":")[0];
    if (base === "D") {
      const series = [
        ...(M.gross_margin !== null && M.gross_margin_p !== null && cogs.c !== null ? [{ name: "毛利率", values: [M.gross_margin_p, M.gross_margin] }] : []),
        { name: "營益率", values: [M.operating_margin_p, M.operating_margin] },
        { name: "淨利率", values: [M.net_margin_p, M.net_margin] },
      ];
      const hasGM = series[0].name === "毛利率";
      cards.push({
        id: "D", template: "T3", header: { ...header, label: "利潤率" }, source: src,
        notes: [...derivedNote(hasGM ? derived.filter((d) => d.startsWith("毛利")) : []), ...(hasGM ? cNotes : []), ...(niBasisNote ? [{ text: niBasisNote, p: 2 }] : [])],
        body: {
          unit: "%", kind: "pct",
          periods: [shiftYear(period, -1), period],
          series,
          endDelta: { kind: "pp", values: series.map((x) => x.values[1] - x.values[0]) },
        },
      });
    }
    if (base === "B") {
      // 畫觸發 B 的那個維度（部門規則有命中就畫部門，否則畫地區）；那個維度資料不完整時改畫另一個
      const segHit = (selection.fired.B || []).some((h) => h.startsWith("segment_"));
      const ok = (bd, why) => (bd && !why ? bd : null);
      const srcB = (segHit && ok(seg, segWhy)) || ok(geo, geoWhy) || ok(seg, segWhy);
      const periodsB = [shiftYear(period, -1), period];
      // 一般部門畫成柱子（負值畫在 0 軸下方）；調節項目兩期都不畫、不列入圖例，改放註腳。同一項目兩期處理方式相同。
      const barRows = srcB.rows.filter((r) => !r.reconciling), recRows = srcB.rows.filter((r) => r.reconciling);
      const totalsB = [disp(rev.p), disp(rev.c)]; // 柱頂總額＝財報公布的營收淨額
      // 例：「總營收含避險損益（−0.21／0.19）。」括號內依柱子由左到右：去年同期／本季。中文與項目名稱之間不加空格
      const foot = recRows.length ? `總營收含${recRows.map((r) => `${useName(r.nm)}（${fmt2(disp(r.p))}／${fmt2(disp(r.c))}）`).join("、")}。` : "";
      cards.push({
        id: "B", template: "T2", header: { ...header, label: srcB === seg ? "營收組成" : "各地區營收" }, source: src, notes: foot ? [{ text: foot, p: 3 }] : [],
        body: {
          unit: unitText, kind: "amount", periods: periodsB,
          series: barRows.map((r) => ({ name: useName(r.nm), values: [disp(r.p), disp(r.c)] })),
          totals: totalsB,
          yoy: barRows.map((r) => r.shown),
          // 整體佔比＝各段 ÷ 財報公布的總營收，標在柱內（業主要求；段太矮放不下就不標）
          shares: barRows.map((r) => [pctOf(r.p, rev.p), pctOf(r.c, rev.c)]),
          sharePosition: "inside",
        },
      });
    }
    if (base === "G") {
      // 只畫有官方依據的數字；股東回饋以獨立長條並列，不做「扣除後餘額」這類自創的差額。
      const steps = [
        { label: "營業現金流", value: disp(ocf.c), type: "total" },
        { label: "資本支出", value: disp(capex.c), type: "use" },
      ];
      if (fcfShown !== null) steps.push({ label: "自由現金流", value: disp(fcfShown), type: "total" });
      if (buy.c) steps.push({ label: "庫藏股買回", value: disp(buy.c), type: "bar", group: "股東回饋" });
      if (div.c) steps.push({ label: "現金股利", value: disp(div.c), type: "bar", group: "股東回饋" });
      cards.push({
        id: "G", template: "T5", header: { ...header, label: "現金流量與股東回饋" }, source: src, notes: fcfShown !== null && fcfNote ? [{ text: fcfNote, p: 1 }] : [],
        body: { unit: unitText, kind: "amount", steps },
      });
    }
  }

  // K1：公司下季財測＋公司明確寫出的財測調整。兩者都沒有就不產出 K1（不顯示「未提供」）。數值不完整的項目不列。
  const curShort = profile.defaults.display_currency;
  const STD_NAMES = { revenue: "營收", operating_income: "營業利益", operating_margin: "營益率", gross_margin: "毛利率", eps: "EPS", free_cash_flow: "自由現金流" };
  // 財測項目名稱：公司規範有指定就用；否則標準項目用固定名稱，其他依科目中文名稱的順序
  const labelOf = (it, id) => {
    const ruled = rules.labels[id];
    if (ruled) useName({ id, en: it.label_source, zh: ruled, origin: "rules" });
    let zh = ruled || STD_NAMES[it.metric] || useName(nameOf(it, id, ctx));
    // 財測的 EPS 口徑依原文名稱（Diluted／Basic）；原文沒寫就只寫 EPS，不推定
    if (it.metric === "eps" && !ruled) zh = /dilut|稀釋/i.test(it.label_source) ? "稀釋 EPS" : /basic|基本/i.test(it.label_source) ? "基本 EPS" : "EPS";
    return it.unit === "monetary" ? `${zh}（${unitText}）` : it.unit === "per_share" ? `${zh}（${curShort}）` : zh;
  };
  /**
   * 一個項目（一列）的數值 → 顯示文字。vals：這一列的財測數值物件（下季財測 1 個；財測調整為前次、本次 2 個）。
   * - 金額需要換算單位時（例如 millions → B），換算後固定 2 位小數。
   * - 未經換算的數字（百分比、每股、單位相同的金額）依原文位數；同一列取位數最多的，不足補 0，不四捨五入。
   * scale＝原文金額單位的 10 次方。
   */
  const showItem = (vals, unit, scale) => {
    const factor = unit === "monetary" ? scale / Math.pow(10, dispPow) : 1;
    const converted = factor !== 1;
    const d = converted ? 2 : itemDecimals(vals.flatMap((v) => [[v, "point"], [v, "low"], [v, "high"]]));
    const one = (x) => {
      const t = converted ? fmt2(x * factor) : fixed(x, d);
      return unit === "percent" ? `${t}%` : t;
    };
    return vals.map((v) => (v.point !== null && v.point !== undefined ? one(v.point) : `${one(v.low)}–${one(v.high)}`));
  };
  const mid = (v) => (v.point !== null && v.point !== undefined ? v.point : (v.low + v.high) / 2);
  const complete = (v) => v && ((typeof v.point === "number") || (typeof v.low === "number" && typeof v.high === "number"));
  const dropRows = [];

  const gRows = [];
  if (g && g.items.length) for (const it of g.items) {
    if (!complete(it)) { dropRows.push(it.label_source); continue; }
    gRows.push({ label: labelOf(it, `guidance:${it.metric}|${it.label_source}`), value: showItem([it], it.unit, guidanceScale)[0] });
  }

  const revRowsK = [];
  for (const r of fs.guidance_revisions || []) {
    if (!complete(r.previous) || !complete(r.current)) { dropRows.push(r.label_source); continue; }
    const scale = Math.pow(10, UNIT_POWER[r.monetary_unit] ?? srcPow);
    const diff = mid(r.current) - mid(r.previous);
    const period = /Q[1-4]$/.test(r.period_label) ? fiscalToCalendar(r.period_label, company.fiscal_year_end_month || 12) : r.period_label;
    const [previous, current] = showItem([r.previous, r.current], r.unit, scale);
    revRowsK.push({ label: labelOf(r, `revision:${r.metric}|${r.label_source}`), period, previous, current, previousDate: r.previous_date || null, dir: diff > 0 ? "up" : diff < 0 ? "down" : "flat" });
  }
  if (dropRows.length) incomplete.push({ card: "K1", reason: `${dropRows.join("、")}數值不完整，未列入` });

  if (gRows.length || revRowsK.length) {
    const sections = [];
    // 財測調整：期間相同時寫在標題（例如「財測調整（FY2026）」），不同時才寫在每一列
    const periods = [...new Set(revRowsK.map((r) => r.period))];
    const revTitle = `財測調整${periods.length === 1 ? `（${periods[0]}）` : ""}`;
    const dates = [...new Set(revRowsK.map((r) => r.previousDate))];
    const prevDate = dates.length === 1 ? dates[0] : null;
    if (gRows.length) sections.push({ heading: "", columns: ["項目", "財測"], rows: gRows });
    if (revRowsK.length) sections.push({
      // 欄名固定為「前次財測／本次財測」（不用「調整前／調整後」，避免和 Adjusted 指標混淆）；
      // 原文有前次財測的發布日期、且每一列都是同一天時，附在欄名後，例如「前次財測（7/17）」
      heading: gRows.length ? revTitle : "", columns: ["項目", `前次財測${prevDate ? `（${prevDate}）` : ""}`, "本次財測"],
      rows: revRowsK.map((r) => ({ cells: [periods.length === 1 ? r.label : `${r.label}｜${r.period}`, r.previous, { arrow: r.dir, value: r.current }] })),
    });
    if (company.next_report_date) sections.push({ heading: "下次財報日期", columns: ["日期", "事件"], rows: [{ label: company.next_report_date, value: "下一季財報公布（公司公告）", text: true }] });
    cards.push({
      id: "K1", template: "T8", header: { ...header, label: gRows.length ? "下季財測" : "財測調整" }, source: src,
      title: gRows.length ? `公司下季財測（${fiscalToCalendar(g.period_label, company.fiscal_year_end_month || 12)}）` : `公司${revTitle}`,
      body: { sections },
    });
  }

  if (overridden("gross_profit_identity")) dropped.push("毛利節點與毛利率（毛利勾稽不符，使用者確認原文如此）");
  selection.dropped = dropped;
  selection.incomplete = incomplete;
  // 張次依 rules/triggers.json 的 order_on_deck 排列
  const ord = triggers.deck.order_on_deck;
  cards.sort((x, y) => ord.indexOf(x.id) - ord.indexOf(y.id));
  if (stopAtOI) for (let i = derived.length - 1; i >= 0; i--) if (derived[i].startsWith("業外")) derived.splice(i, 1);
  // ── 17. 圖卡數字核對表：圖卡上的重點數字，與新聞稿比對（預填新聞稿數字；分類在 lib/verify.js）
  //   value：圖卡用的數字（顯示單位、未四捨五入）；shown：圖卡上的文字；alts：工具算得出的其他口徑（新聞稿若等於其中之一＝定義不同）
  const verify = buildVerify();
  function buildVerify() {
    const rows = new Map();
    const on = (id) => cards.some((c) => c.id === id);
    const amt = (v) => (v === null || v === undefined ? null : disp(v));
    const pctv = (a, b) => pctOf(a, b);
    const put = (key, label, kind, value, decimals, card, extra = {}) => {
      if (value === null || value === undefined || typeof value !== "number") return;
      const r = rows.get(key) || { key, label, kind, value, decimals, cards: [], alts: [], ...extra };
      if (!r.cards.includes(card)) r.cards.push(card);
      rows.set(key, r);
    };
    const nonGaap = fs.market_specific?.us || {};
    const ngOI = { c: cur(nonGaap.non_gaap_operating_income), p: pri(nonGaap.non_gaap_operating_income) };
    const ngNI = { c: cur(nonGaap.non_gaap_net_income), p: pri(nonGaap.non_gaap_net_income) };
    const ngEPS = { c: cur(nonGaap.non_gaap_eps_diluted), p: pri(nonGaap.non_gaap_eps_diluted) };
    const recSum = (k) => { const rr = [...(seg?.rows || []), ...(geo?.rows || [])].filter((r) => r.reconciling && r[k] !== null); return rr.length ? rr.reduce((a, r) => a + r[k], 0) : null; };
    const recNames = [...new Set([...(seg?.rows || []), ...(geo?.rows || [])].filter((r) => r.reconciling).map((r) => r.nm.zh))].join("、");
    const niOurs = niP.c === ni.c ? "損益表淨利" : "歸屬母公司淨利";
    const niAlts = (f) => [
      ...(ni.c !== niP.c ? [{ value: f(ni), def: "損益表淨利（含非控制權益）" }] : []),
      ...(niCommon && r2d(niCommon.c) !== r2d(niP.c) ? [{ value: f(niCommon), def: "歸屬普通股股東淨利" }] : []),
      ...(ngNI.c !== null ? [{ value: f(ngNI), def: "Non-GAAP 淨利" }] : []),
    ].filter((a) => a.value !== null);
    if (on("A1")) {
      put("revenue", "營收", "amount", amt(rev.c), 2, "A1");
      const ry = yoyShown(rev.c, rev.p);
      if (typeof ry === "number") put("revenue_yoy", "營收年增率", "pct", ry, 1, "A1");
      put("operating_margin", "營益率", "pct", M.operating_margin, 1, "A1");
      put("eps", epsZh, "perShare", eps.c, epsDec, "A1");
      const ey = yoyShown(eps.c, eps.p, M.eps_yoy);
      if (typeof ey === "number") put("eps_yoy", `${epsZh} 年增率`, "pct", ey, M.eps_yoy_decimals, "A1");
    }
    if (on("C")) {
      if (chartGp.c !== null && cogs.c !== null) { put("gross_profit", "毛利", "amount", amt(chartGp.c), 2, "C"); put("gross_margin", "毛利率", "pct", M.gross_margin, 1, "C"); }
      put("operating_income", "營業利益", "amount", amt(oi.c), 2, "C");
      put("operating_margin", "營益率", "pct", M.operating_margin, 1, "C");
      if (!stopAtOI) { put("net_income", "淨利", "amount", amt(niP.c), 2, "C"); put("net_margin", "淨利率", "pct", M.net_margin, 1, "C"); }
    }
    if (on("D")) {
      if (M.gross_margin !== null && cogs.c !== null) put("gross_margin", "毛利率", "pct", M.gross_margin, 1, "D");
      put("operating_margin", "營益率", "pct", M.operating_margin, 1, "D");
      put("net_margin", "淨利率", "pct", M.net_margin, 1, "D");
    }
    const bCard = cards.find((c) => c.id === "B");
    if (bCard) for (const r of [...(seg?.rows || []), ...(geo?.rows || [])]) {
      if (r.reconciling || !bCard.body.series.some((x) => x.name === r.nm.zh)) continue;
      put(`seg:${r.key}`, `${r.nm.zh}營收`, "amount", amt(r.c), 2, "B", { item: r.key });
    }
    if (on("G")) {
      put("operating_cash_flow", "營業現金流", "amount", amt(ocf.c), 2, "G");
      put("capex", "資本支出", "amount", amt(capex.c), 2, "G");
      if (fcfShown !== null) put("free_cash_flow", "自由現金流", "amount", amt(fcfShown), 2, "G");
      if (buy.c) put("buybacks", "庫藏股買回", "amount", amt(buy.c), 2, "G");
      if (div.c) put("dividends", "現金股利", "amount", amt(div.c), 2, "G");
    }
    // 其他口徑（工具算得出來的）
    const R_ = (k) => rows.get(k);
    const addAlt = (k, alts, ours) => { const r = R_(k); if (r) { r.alts.push(...alts.filter((a) => a.value !== null && a.value !== undefined)); if (ours) r.ours = ours; } };
    const rx = recSum("c"), rxp = recSum("p");
    if (rx !== null) {
      addAlt("revenue", [{ value: amt(rev.c - rx), def: `不含${recNames}的營收` }], `含${recNames}的總營收`);
      if (rxp !== null) addAlt("revenue_yoy", [{ value: yoy(rev.c - rx, rev.p - rxp), def: `不含${recNames}計算` }], `含${recNames}計算`);
    }
    addAlt("net_income", niAlts((x) => amt(x.c)), niOurs);
    addAlt("net_margin", niAlts((x) => pctv(x.c, rev.c)), `${niOurs}計算`);
    addAlt("operating_income", ngOI.c !== null ? [{ value: amt(ngOI.c), def: "Non-GAAP 營業利益" }] : [], "GAAP 營業利益");
    addAlt("operating_margin", ngOI.c !== null ? [{ value: pctv(ngOI.c, rev.c), def: "Non-GAAP 營業利益計算" }] : [], "GAAP 營業利益計算");
    const otherBasis = epsBasis === "basic" ? IS.eps_diluted : IS.eps_basic;
    addAlt("eps", [...(ngEPS.c !== null ? [{ value: ngEPS.c, def: "Non-GAAP EPS" }] : []), ...(cur(otherBasis) !== null ? [{ value: cur(otherBasis), def: epsBasis === "basic" ? "稀釋 EPS" : "基本 EPS" }] : [])], `GAAP ${epsZh}`);
    // EPS 年增率：四捨五入前的 EPS 算出來的視為四捨五入差異（silent，不加附註）
    addAlt("eps_yoy", [...(epsYoyNps !== null ? [{ value: epsYoyNps, def: "四捨五入前的 EPS 計算", silent: true }] : []), ...(epsYoyRange() ? [{ value: epsYoyRange()[0], def: "公布 EPS 四捨五入範圍", silent: true, range: epsYoyRange() }] : []),
      ...(ngEPS.c !== null && ngEPS.p !== null ? [{ value: yoy(ngEPS.c, ngEPS.p), def: "Non-GAAP EPS 計算" }] : [])], `GAAP ${epsZh}計算`);
    if (fcfStated !== null && ocf.c !== null && capex.c !== null) addAlt("free_cash_flow", fcfShown === fcfStated ? [{ value: amt(ocf.c - capex.c), def: "營業現金流 − 資本支出" }] : [{ value: amt(fcfStated), def: "公司公布的自由現金流" }], fcfShown === fcfStated ? "公司公布的自由現金流" : "營業現金流 − 資本支出");
    if (gp.c !== null && cogs.c !== null && chartGp.c !== null) {
      const gStated = cur(IS.gross_profit), gCalc = rev.c - cogs.c;
      if (gStated !== null && Math.abs(gStated - gCalc) > tol(2)) addAlt("gross_profit", [{ value: amt(chartGp.c === gStated ? gCalc : gStated), def: chartGp.c === gStated ? "營收 − 營業成本" : "損益表上的毛利" }], chartGp.c === gStated ? "損益表上的毛利" : "營收 − 營業成本");
    }
    // 預填：AI 抄下的新聞稿重點數字（headline_figures），其次是公司寫的比率（stated_metrics）
    const toDispAmount = (v, unit) => (UNIT_POWER[unit] === undefined ? v : (v * Math.pow(10, UNIT_POWER[unit])) / Math.pow(10, dispPow));
    const fmtIn = (v, d) => (typeof v === "number" ? (d === undefined ? String(v) : v.toFixed(d)) : "");
    for (const h of fs.headline_figures || []) {
      const key = h.metric === "segment_revenue" ? `seg:${h.item}` : h.metric;
      const r = rows.get(key);
      if (!r || r.prefill) continue;
      const v = h.unit === "monetary" ? toDispAmount(h.value, h.monetary_unit) : h.value;
      const d = h.unit === "monetary" && UNIT_POWER[h.monetary_unit] !== undefined && h.monetary_unit !== "billions" ? Math.max(0, 2) : decOf(h, "value");
      r.prefill = { value: fmtIn(v, d), src: h.src?.quote || "" };
    }
    for (const sm of fs.stated_metrics || []) {
      const key = sm.metric === "revenue_amount" ? "revenue" : sm.metric;
      const r = rows.get(key);
      if (!r || r.prefill) continue;
      const v = sm.metric === "revenue_amount" ? toDispAmount(sm.value, sm.unit) : sm.value;
      r.prefill = { value: fmtIn(v, sm.metric === "revenue_amount" && sm.unit !== "billions" ? 2 : decOf(sm, "value")), src: sm.src?.quote || "" };
    }
    // 圖卡上的文字
    for (const r of rows.values()) {
      r.shown = r.kind === "pct" ? `${fixed(r.value, r.decimals)}%` : fixed(r.value, r.decimals);
      r.unit = r.kind === "amount" ? unitText : r.kind === "pct" ? "%" : profile.defaults.display_currency;
    }
    return [...rows.values()];
  }

  // 公司規範畫面用的資訊（只列本季有的項目）
  const revenueItems = (list, dim) => (list || []).filter((s) => s.revenue).map((s) => {
    const meta = (company.geographies || []).concat(company.segments || []).find((x) => x.key === s.key);
    const ruled = rules.revenue_items.reconciling[s.key];
    return { key: s.key, dim, name: nameOf(s, `${dim === "部門" ? "seg" : "geo"}:${s.key}`, ctx, meta?.label_zh).zh, en: s.label_source,
      base: !!(meta?.reconciling ?? s.reconciling), reconciling: typeof ruled === "boolean" ? ruled : !!(meta?.reconciling ?? s.reconciling), subtotal: subtotal.has(s.key) };
  });
  const companyInfo = {
    labels: [...labelsUsed.values()],
    issues: ruleIssues,
    opex: itemsBase.map((it) => ({ key: it.key, name: it.nm.zh, en: it.label })),
    hasCostOfRevenue: cogsBase.c !== null,
    hasCommon: !!niCommon,
    revenueItems: [...revenueItems(fs.segments, "部門"), ...revenueItems(fs.geographies, "地區")],
  };
  return { checks, derived, derivable, metrics: M, selection, cards, verify, company: companyInfo, units: { source: m.monetary_unit, display: unitText, srcPow, dispPow }, revenueDisplay: disp(rev.c) };
}

// ───────── 選圖 ─────────
function evalCond(cond, M) {
  if (cond.any) {
    const rs = cond.any.map((c) => evalCond(c, M));
    const known = rs.filter((r) => r.value !== null);
    return { value: known.length ? known.some((r) => r.value) : null, hits: rs.flatMap((r) => r.hits || []), missing: rs.flatMap((r) => r.missing || []) };
  }
  const v = M[cond.metric];
  if (v === null || v === undefined) return { value: null, missing: [cond.metric] };
  let ok;
  switch (cond.op) {
    case "abs_gte": ok = Math.abs(v) >= cond.value; break;
    case "gte": ok = v >= cond.value; break;
    case "eq": ok = v === cond.value; break;
    case "in": ok = cond.value.includes(v); break;
    case "is_true": ok = v === true; break;
    case "exists": ok = v !== null && v !== undefined; break;
    default: ok = false;
  }
  return { value: ok, hits: ok ? [`${cond.metric}=${typeof v === "number" ? v.toFixed(2) : v}`] : [], missing: [] };
}

export function selectModules(M, triggers, env) {
  // 指標換算成規則使用的單位（佔比與年增率差：百分點；capex_yoy：比例）
  const MM = { ...M,
    capex_yoy: M.capex_yoy === null ? null : M.capex_yoy / 100,
    capital_return_yoy: M.capital_return_yoy === null ? null : M.capital_return_yoy / 100,
    guidance_position: env.hasGuidancePrev ? M.guidance_position ?? null : null,
    consensus_gap: env.consensus && env.consensus.length ? 1 : null,
    peers_available: env.peers ? true : null,
    kpi_extreme: null, kpi_growth_sign_flip: null,
  };
  const fired = {}, skipped = {};
  for (const [code, mod] of Object.entries(triggers.modules)) {
    if (mod.type !== "conditional") continue;
    if (mod.variants) {
      for (const [vcode, v] of Object.entries(mod.variants)) {
        const r = evalCond(v.when, MM);
        if (r.value) fired[vcode] = r.hits; else if (r.value === null) skipped[vcode] = r.missing;
      }
    } else {
      const r = evalCond(mod.when, MM);
      if (r.value) fired[code] = r.hits; else if (r.value === null) skipped[code] = r.missing;
    }
  }
  const canBuild = (c) => !env.buildable || env.buildable.includes(c.split(":")[0]);
  // 資料不完整的圖卡不選，由下一順位遞補
  const complete = (c) => !env.available || env.available[c.split(":")[0]] !== false;
  const chosen = triggers.deck.selection_priority.filter((c) => fired[c] && canBuild(c) && complete(c)).slice(0, triggers.deck.max_conditional);
  const incompleteFired = [...new Set(Object.keys(fired).filter((c) => canBuild(c) && !complete(c)).map((c) => c.split(":")[0]))];
  const unbuilt = Object.keys(fired).filter((c) => !canBuild(c));
  const order = triggers.deck.order_on_deck;
  const deck = order.filter((c) => triggers.deck.fixed.includes(c) || chosen.some((x) => x.split(":")[0] === c));
  return { fired, skipped, chosen, deck, unbuilt, incompleteFired };
}

// ───────── 期間與格式 ─────────
export function fiscalToCalendar(fp, fyEnd = 12) {
  const mt = /^FY(\d{4})Q([1-4])$/.exec(fp || "");
  if (!mt) return fp;
  let y = +mt[1], q = +mt[2];
  if (fyEnd === 12) return `${y}Q${q}`;
  // 財年結束月 → 該財年第 q 季的最後一個月
  let endMonth = fyEnd - (4 - q) * 3;
  let yy = y;
  while (endMonth <= 0) { endMonth += 12; yy -= 1; }
  return `${yy}Q${Math.ceil(endMonth / 3)}`;
}
const shiftYear = (p, d) => p.replace(/^(\d{4})/, (y) => String(+y + d));

// ───────── 雙重抽取比對 ─────────
/** 攤平兩份數據表的所有數字，列出不一致之處 */
export function diffExtractions(a, b) {
  const flat = (o, p = "", out = {}) => {
    if (o && typeof o === "object") {
      if ("value" in o && (typeof o.value === "number" || o.value === null) && !Array.isArray(o)) {
        out[p] = { value: o.value, period_type: o.period_type || "quarter", unit_hint: null };
        return out;
      }
      // 陣列依內容對齊（不依順序）：拆分用 key、財測用 metric＋原文名稱、原文比率用 metric＋數值
      const idOf = (x, i) => x?.key ?? (x?.metric && x?.label_source ? `${x.metric}|${x.label_source}` : x?.metric !== undefined && x?.value !== undefined ? `${x.metric}|${x.value}` : i);
      if (Array.isArray(o)) o.forEach((x, i) => flat(x, `${p}[${idOf(x, i)}]`, out));
      else for (const [k, v] of Object.entries(o)) {
        if (["src", "extraction", "ambiguities", "cross_check", "comment", "key", "label_source", "label_zh", "unit", "metric"].includes(k)) continue;
        flat(v, p ? `${p}.${k}` : k, out);
      }
    } else if (typeof o === "number" || typeof o === "string") out[p] = { value: o };
    return out;
  };
  const A = flat(a), B = flat(b);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const diffs = [];
  for (const k of keys) {
    if (/^meta\.(source_docs|period_end_src|monetary_unit_src)/.test(k)) continue;
    const x = A[k], y = B[k];
    if (!x) diffs.push({ path: k, a: "（無）", b: y.value, type: "只有 B 有" });
    else if (!y) diffs.push({ path: k, a: x.value, b: "（無）", type: "只有 A 有" });
    else if (x.value !== y.value || x.period_type !== y.period_type) diffs.push({ path: k, a: `${x.value}${x.period_type && x.period_type !== "quarter" ? "（" + x.period_type + "）" : ""}`, b: `${y.value}${y.period_type && y.period_type !== "quarter" ? "（" + y.period_type + "）" : ""}`, type: "數值不同" });
  }
  return diffs;
}

/** 給人工核對用的差異清單：略過只用於驗算的欄位，並把同一項目的本季／去年／上季合併成一列 */
export function diffForReview(a, b) {
  const raw = diffExtractions(a, b).filter((d) => !/^stated_metrics|^market_specific|^headline_figures/.test(d.path) && !(d.a === null && d.b === null));
  const groups = new Map();
  for (const d of raw) {
    const key = d.path.replace(/\.(current|prior_year|prior_quarter|point|low|high|basis)$/, "");
    const tag = (d.path.match(/\.(current|prior_year|prior_quarter|point|low|high|basis)$/) || [])[1];
    const tagZh = { current: "本季", prior_year: "去年", prior_quarter: "上季", point: "數值", low: "下緣", high: "上緣", basis: "基準" }[tag] || "";
    if (!groups.has(key)) groups.set(key, { path: key, a: [], b: [], type: d.type, paths: [] });
    const g = groups.get(key);
    g.paths.push(d.path);
    g.a.push(tagZh ? `${tagZh} ${d.a}` : d.a);
    g.b.push(tagZh ? `${tagZh} ${d.b}` : d.b);
  }
  return [...groups.values()].map((g) => ({ ...g, a: g.a.join("；"), b: g.b.join("；") }));
}

/** 貼上的文字 → JSON：自動去掉 ```json 程式碼框，以及 AI 在 JSON 前後多寫的說明文字 */
/** 同時記錄每個數字的原文小數位數（見 lib/decimals.js） */
export function parseFactSheet(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let body = t;
  try {
    JSON.parse(t); // 先用內建解析確認格式（錯誤訊息較清楚）
  } catch (e) {
    const i = t.indexOf("{"), j = t.lastIndexOf("}");
    if (!(i > 0 || (j >= 0 && j < t.length - 1))) throw e;
    body = t.slice(i, j + 1);
    JSON.parse(body);
  }
  return parseWithDecimals(body);
}
