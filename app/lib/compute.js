// 計算層：數據表 → 自動檢查 → 指標 → 選圖 → 圖卡 spec
// 純計算，不碰畫面；瀏覽器與 Node 都能執行。
//
// analyze(fs, ctx) 回傳：
//   checks    自動檢查結果（pass／fail／warn／skip）
//   derived   依損益表科目計算、原文沒有直接列出的數字（圖卡底部會註明）
//   derivable 可計算的數字清單（核對畫面第三層列出，供確認原文確實沒有這一列）
//   labels    圖卡上用到、需要人確認的科目名稱：AI 譯名（origin: ai）或缺少中文名稱（origin: missing）
//   metrics   指標（年增率、利潤率、佔比…）
//   selection 這次做哪幾張、哪些規則觸發、哪些因資料不足略過、哪些因覆寫而不畫
//   cards     給底稿的 spec（A1、C、條件模組、K1）
//
// ctx: { profile, company, triggers, labels, history, overrides }
//   overrides：使用者在第三層對「不通過」選了「數據正確」的檢查 id 清單

import { amount as fmt2, fixed1 as fmt1, fixed } from "./format.js";
import { parseWithDecimals, itemDecimals, decOf } from "./decimals.js";

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
const pctOf = (a, b) => (a !== null && b !== null && b !== 0 ? (a / b) * 100 : null);

const UNIT_POWER = { ones: 0, thousands: 3, millions: 6, billions: 9 };
const DISPLAY_POWER = { billions: 9, hundred_millions: 8, millions: 6 };
const DISPLAY_LABEL = { billions: "B", hundred_millions: "億", millions: "M" };

/** 依標籤正規化，用來辨識「營業成本」等列 */
const norm = (s) => String(s || "").toLowerCase().replace(/[*:：]/g, "").replace(/\s+/g, " ").trim();

const HAS_CJK = /[\u3400-\u9fff]/;

/**
 * 科目中文名稱。圖卡標籤一律中文，依序採用：
 *   1. 公司設定檔的 label_zh（companies/*.json）
 *   2. 原文本身就是中文（台股）
 *   3. 科目對照表（references/labels_zh.json）
 *   4. AI 的譯名 label_zh（台灣常用財報用語）→ 第三層「需要確認」
 *   5. 都沒有 → 標為缺少中文名稱（第三層處理，不直接印英文）
 * path：該項目在數據表中的路徑（例如 operating_expense_items[technology_and_development]），用來修改譯名
 */
function nameOf(item, path, ctx, companyZh) {
  const en = item.label_source;
  const at = { en, path: `${path}.label_zh` };
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
  // 圖卡上實際用到、需要人確認的科目名稱（AI 譯名或缺少中文名稱）
  const labelsUsed = new Map();
  const useName = (n) => { if (n.origin === "ai" || n.origin === "missing") labelsUsed.set(n.path, n); return n.zh; };
  const add = (id, label, status, detail = "") => checks.push({ id, label, status, detail });
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
  let cogs = { c: cur(IS.cost_of_revenue), p: pri(IS.cost_of_revenue) };
  const items = [];
  for (const it of fs.operating_expense_items || []) {
    const c = cur(it.amount), p = pri(it.amount);
    if (cogsAliases.includes(norm(it.label_source))) {
      if (cogs.c === null) cogs = { c, p };
      continue; // 營業成本不放進營業費用，避免重複扣除
    }
    items.push({ key: it.key, label: it.label_source, nm: nameOf(it, `operating_expense_items[${it.key}]`, ctx), c: Math.abs(c), p: p === null ? null : Math.abs(p) });
  }
  if (cogs.c !== null) cogs = { c: Math.abs(cogs.c), p: cogs.p === null ? null : Math.abs(cogs.p) };

  const rev = { c: cur(IS.revenue), p: pri(IS.revenue) };
  const oi = { c: cur(IS.operating_income), p: pri(IS.operating_income) };
  const pretax = { c: cur(IS.pretax_income), p: pri(IS.pretax_income) };
  const ni = { c: cur(IS.net_income), p: pri(IS.net_income) };
  const niP = { c: cur(IS.net_income_to_parent) ?? ni.c, p: pri(IS.net_income_to_parent) ?? ni.p };
  const other = { c: cur(IS.other_operating_net) ?? 0, p: pri(IS.other_operating_net) ?? 0 };
  const opexTotal = { c: cur(IS.operating_expenses_total), p: pri(IS.operating_expenses_total) };

  // ── 3. 毛利：原文有就用；沒有但有營業成本 → 依損益表科目計算並註明（rules/derivations.json）
  let gp = { c: cur(IS.gross_profit), p: pri(IS.gross_profit) };
  if (gp.c !== null && cogs.c !== null) {
    const d = rev.c - cogs.c - gp.c;
    add("gross_profit_identity", "毛利＝營收−營業成本", Math.abs(d) <= tol(2) ? "pass" : "fail", `差 ${d}`);
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

  // EPS 勾稽（股數與金額單位可能不同）：只用來檢查抽取是否正確，不用來算年增率
  const shPow = UNIT_POWER[m.share_unit] ?? srcPow;
  const shZh = `${EPS_ZH[epsBasis]}股數`;
  const epsCalc = (k) => {
    const sh = k === "c" ? cur(shPair) : pri(shPair);
    return niP[k] !== null && sh ? (niP[k] * Math.pow(10, srcPow)) / (sh * Math.pow(10, shPow)) : null;
  };
  for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
    const e = epsCalc(k);
    if (e === null || eps[k] === null) { add(`eps_identity_${k}`, `${lab}：EPS≈淨利÷${shZh}`, "skip"); continue; }
    add(`eps_identity_${k}`, `${lab}：EPS≈淨利÷${shZh}`, Math.abs(e - eps[k]) <= 0.01 ? "pass" : "fail", `計算 ${e.toFixed(4)}，原文 ${eps[k]}`);
  }

  // ── 8. 營收拆分加總（同時偵測單位不一致）
  function sumCheck(list, name) {
    if (!list || !list.length) return add(`${name}_sum`, `${name === "segments" ? "部門" : "地區"}加總＝營收`, "skip", "無資料");
    const items2 = list.filter((s) => s.revenue);
    if (!items2.length) return add(`${name}_sum`, "拆分加總", "skip", "只有百分比");
    for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
      const s = items2.reduce((a, x) => a + ((k === "c" ? cur(x.revenue) : pri(x.revenue)) ?? 0), 0);
      const target = rev[k];
      if (target === null) continue;
      const ratio = s / target;
      let status = Math.abs(s - target) <= tol(items2.length) ? "pass" : "fail";
      let detail = `加總 ${s}，營收 ${target}`;
      if (status === "fail" && (Math.abs(ratio - 0.001) < 0.0002 || Math.abs(ratio - 1000) < 200)) detail += "｜疑似單位不一致（相差約 1000 倍）";
      add(`${name}_sum_${k}`, `${lab}：${name === "segments" ? "部門" : "地區"}加總＝營收`, status, detail);
    }
  }
  sumCheck(fs.segments, "segments");
  sumCheck(fs.geographies, "geographies");

  // ── 9. 指標
  const M = {};
  M.revenue_yoy = yoy(rev.c, rev.p);
  M.gross_margin = pctOf(gpShown.c, rev.c); M.gross_margin_p = pctOf(gpShown.p, rev.p);
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
  const cogsQ = pq(IS.cost_of_revenue) ?? (fs.operating_expense_items || []).filter((it) => cogsAliases.includes(norm(it.label_source))).map((it) => pq(it.amount))[0] ?? null;
  const gpQ = gpHidden ? null : pq(IS.gross_profit) ?? (revQ !== null && cogsQ !== null ? revQ - Math.abs(cogsQ) : null);
  M.gross_margin_q = pctOf(gpQ, revQ); M.operating_margin_q = pctOf(oiQ, revQ); M.net_margin_q = pctOf(niQ, revQ);
  M.gross_margin_change_pp_qoq = M.gross_margin !== null && M.gross_margin_q !== null ? M.gross_margin - M.gross_margin_q : null;
  M.operating_margin_change_pp_qoq = M.operating_margin !== null && M.operating_margin_q !== null ? M.operating_margin - M.operating_margin_q : null;
  M.net_margin_change_pp_qoq = M.net_margin !== null && M.net_margin_q !== null ? M.net_margin - M.net_margin_q : null;
  M.revenue_qoq = yoy(rev.c, revQ);
  M.margin_8q_extreme = null; // 需要 7 季歷史存檔，目前工具尚未讀取 history/

  // 拆分指標
  function breakdown(list, listName) {
    if (!list || !list.length) return null;
    const rows = list.filter((s) => s.revenue).map((s) => {
      const c = cur(s.revenue), p = pri(s.revenue);
      const meta = (company.geographies || []).concat(company.segments || []).find((x) => x.key === s.key);
      return { key: s.key, nm: nameOf(s, `${listName}[${s.key}]`, ctx, meta?.label_zh), c, p, share: pctOf(c, rev.c), share_p: pctOf(p, rev.p), yoy: yoy(c, p), shown: yoyShown(c, p),
        // 調節項目：列在各部門小計之外、但計入總營收的項目（公司設定檔或 AI 標示）。不畫進柱子，改放註腳
        reconciling: !!(meta?.reconciling ?? s.reconciling) };
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
  if (fcfStated !== null && ocf.c !== null && capex.c !== null) {
    const d = ocf.c - capex.c - fcfStated;
    add("fcf_identity", "自由現金流＝營業現金流−資本支出", Math.abs(d) <= tol(2) ? "pass" : "warn", `差 ${d}（公司定義可能不同）`);
  }

  // ── 10. 公司自己寫出的比率 → 驗證 PN 的計算（容許值依原文精度）
  const statedMap = { revenue_yoy: M.revenue_yoy, operating_margin: M.operating_margin, gross_margin: M.gross_margin, net_margin: M.net_margin, eps_yoy: M.eps_yoy, revenue_qoq: M.revenue_qoq };
  // 公布的 EPS 已四捨五入，公司自己寫的 EPS 年增率可能用未四捨五入的數字算：容許 EPS 尾數 ±0.5 個最小單位造成的差異
  const epsYoyRange = () => {
    if (eps.c === null || eps.p === null) return null;
    const h = 0.5 * Math.pow(10, -epsDec);
    const vs = [[eps.c - h, eps.p - h], [eps.c - h, eps.p + h], [eps.c + h, eps.p - h], [eps.c + h, eps.p + h]].map(([a, b]) => yoy(a, b)).filter((x) => x !== null);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : null;
  };
  const epsStatedOk = []; // 通過檢查的公司公布 EPS 年增率
  for (const s of fs.stated_metrics || []) {
    if (!(s.metric in statedMap) || statedMap[s.metric] === null) continue;
    const calc = statedMap[s.metric];
    const allow = 0.5 * Math.pow(10, -decOf(s, "value")) + 0.05;
    const rg = s.metric === "eps_yoy" ? epsYoyRange() : null;
    const ok = rg ? s.value >= rg[0] - allow && s.value <= rg[1] + allow : Math.abs(calc - s.value) <= allow;
    if (s.metric === "eps_yoy" && ok && s.unit === "percent") epsStatedOk.push(s);
    add(`stated_${s.metric}_${s.value}`, `原文寫 ${s.metric} ${s.value}${s.unit === "percent" ? "%" : ""}`, ok ? "pass" : "fail",
      `PN 計算 ${calc.toFixed(2)}${rg && ok && Math.abs(calc - s.value) > allow ? "（差異在公布 EPS 四捨五入的範圍內）" : ""}${rg && !ok ? "；不在公布 EPS 四捨五入可能的範圍內，可能抓到非 GAAP、其他口徑或累計期間的年增率。圖卡不採用這個數字，改用公布的 EPS 計算" : ""}`);
  }
  // 公司有寫 EPS 年增率、且與公布 EPS 一致 → 圖卡用公司的數字（位數依原文；表格與內文各寫一次時用位數較多的）
  if (epsStatedOk.length) {
    const best = epsStatedOk.reduce((a, x) => (decOf(x, "value") > decOf(a, "value") ? x : a));
    M.eps_yoy = best.value;
    M.eps_yoy_decimals = decOf(best, "value");
    M.eps_yoy_source = "stated";
  }
  if (M.eps_yoy !== null) add("eps_yoy_source", "EPS 年增率的來源", "pass",
    M.eps_yoy_source === "stated" ? `採用公司公布的 ${fixed(M.eps_yoy, M.eps_yoy_decimals)}%（與公布 EPS 一致）` : `公司未寫出可採用的 EPS 年增率，依公布 EPS 計算為 ${fmt1(M.eps_yoy)}%`);

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

  // ── 14. 選圖
  // 目前已接上圖卡資料的條件模組；E（對比預期）、F（營運指標）、I（同業）的規則已寫好，但圖卡資料尚未接上，
  // 觸發了也不佔用張數，避免排擠掉真正畫得出來的圖卡。
  const BUILDABLE = ["B", "D", "G"];
  const selection = selectModules(M, triggers, { hasGuidancePrev: !!last?.guidance_next, consensus: fs.consensus, peers: false, buildable: BUILDABLE });

  // ── 15. 圖卡 spec
  const disp = (v) => toDisp(v);
  const period = fiscalToCalendar(m.fiscal_period, company.fiscal_year_end_month || 12);
  const header = { ticker: m.ticker, period, label: "財報快報" };
  const docName = company.source_doc_name_zh || "財報新聞稿";
  const baseSource = `資料來源：${company.company_name_zh || m.company_name} ${period} ${docName}（${m.report_date}）`;
  // 圖卡底部只寫名稱，不寫主詞（帳號署名已在右下角），例如「毛利、業外收支淨額依損益表科目計算」；公式寫在 rules/derivations.json 與核對畫面
  const withDerived = (list) => (list.length ? `${baseSource}。${list.map((d) => d.replace(/（.*）$/, "")).join("、")}依損益表科目計算。` : `${baseSource}。`);

  const cards = [];
  const name = company.company_name_zh || m.company_name;
  // A1
  cards.push({
    id: "A1", template: "T1", header, source: `${baseSource}。`,
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

  // C
  const highlight = triggers.modules.C.annotations[0];
  const hl = evalCond(highlight.when, M).value;
  const stopAtOI = overridden("pretax_identity") || overridden("net_income_identity");
  if (overridden("pretax_identity") || overridden("net_income_identity")) dropped.push("損益流向圖的業外、所得稅、淨利段（勾稽不符，使用者確認原文如此）");
  if (overridden("operating_income_identity_c")) dropped.push("損益流向卡（營業利益與各項費用對不起來，使用者確認原文如此）");
  if (!overridden("operating_income_identity_c")) cards.push({
    id: "C", template: "T4", header: { ...header, label: "損益流向" },
    source: withDerived(stopAtOI ? derived.filter((d) => !d.startsWith("業外")) : derived),
    body: {
      unit: unitText,
      revenue: disp(rev.c), cogs: cogs.c === null ? 0 : disp(cogs.c), grossProfit: gpShown.c === null ? null : disp(gpShown.c),
      stopAt: stopAtOI ? "operating_income" : undefined,
      opex: items.map((it) => ({ name: useName(it.nm), value: disp(it.c) })),
      otherOperating: disp(other.c || 0), operatingIncome: disp(oi.c),
      nonOperating: disp(nonop.c || 0), tax: disp(tax.c ?? 0), netIncome: disp(niP.c),
      margins: { gross: gpShown.c !== null && cogs.c !== null ? M.gross_margin : undefined, operating: M.operating_margin, net: M.net_margin },
      note: hl ? (fs.notable_items?.length ? fs.notable_items.map((x, i) => `${useName(nameOf(x, `notable_items[${i}]`, ctx))} ${fmt2(disp(num(x.amount)))}`).join("；") : `業外收支淨額佔淨利 ${fmt1(M.non_operating_share_of_net_income * 100)}%`) : undefined,
    },
  });

  // 條件模組
  for (const code of selection.chosen) {
    const base = code.split(":")[0];
    if (base === "D") {
      const series = [
        ...(M.gross_margin !== null && cogs.c !== null ? [{ name: "毛利率", values: [M.gross_margin_p, M.gross_margin] }] : []),
        { name: "營益率", values: [M.operating_margin_p, M.operating_margin] },
        { name: "淨利率", values: [M.net_margin_p, M.net_margin] },
      ];
      cards.push({
        id: "D", template: "T3", header: { ...header, label: "利潤率" }, source: withDerived(derived.filter((d) => d.startsWith("毛利"))),
        body: {
          unit: "%", kind: "pct",
          periods: [shiftYear(period, -1), period],
          series,
          endDelta: { kind: "pp", values: series.map((x) => x.values[1] - x.values[0]) },
        },
      });
    }
    if (base === "B") {
      // 畫觸發 B 的那個維度：部門規則有命中就畫部門，否則畫地區
      const segHit = (selection.fired.B || []).some((h) => h.startsWith("segment_"));
      const src = (segHit && seg) || geo || seg;
      const periodsB = [shiftYear(period, -1), period];
      // 一般部門畫成柱子（負值畫在 0 軸下方）；調節項目兩期都不畫、不列入圖例，改放註腳。同一項目兩期處理方式相同。
      const barRows = src.rows.filter((r) => !r.reconciling), recRows = src.rows.filter((r) => r.reconciling);
      const totalsB = [disp(rev.p), disp(rev.c)]; // 柱頂總額＝財報公布的營收淨額
      const r2 = (v) => Math.round(v * 100) / 100;
      const foot = recRows.length ? periodsB.map((pl, i) => {
        const parts = recRows.filter((r) => (i ? r.c : r.p) !== null).map((r) => `${useName(r.nm)} ${fmt2(disp(i ? r.c : r.p))}`);
        return parts.length ? `${pl} 總營收 ${fmt2(totalsB[i])} 含 ${parts.join("、")}` : null;
      }).filter(Boolean).join("；") : "";
      // 柱內各段加總＋註腳項目＝柱頂總額（依圖上顯示的 2 位小數，容許四捨五入誤差）
      periodsB.forEach((pl, i) => {
        const vals = src.rows.map((r) => (i ? r.c : r.p)).filter((v) => v !== null).map((v) => r2(disp(v)));
        if (totalsB[i] === null || !vals.length) return;
        const d = vals.reduce((a, x) => a + x, 0) - r2(totalsB[i]);
        add(`b_card_sum_${i ? "c" : "p"}`, `營收拆解卡（${pl}）：柱內加總＋註腳＝柱頂總額`, Math.abs(d) <= 0.005 * (vals.length + 1) + 1e-9 ? "pass" : "fail", `差 ${d.toFixed(2)}`);
      });
      cards.push({
        id: "B", template: "T2", header: { ...header, label: src === seg ? "營收組成" : "各地區營收" }, source: `${baseSource}。${foot ? `${foot}。` : ""}`,
        body: {
          unit: unitText, kind: "amount", periods: periodsB,
          series: barRows.map((r) => ({ name: useName(r.nm), values: [disp(r.p), disp(r.c)] })),
          totals: totalsB,
          yoy: barRows.map((r) => r.shown),
        },
      });
    }
    if (base === "G") {
      // 只畫有官方依據的數字：自由現金流只用公司自己公布的數字（各公司定義不同，不自行計算）；
      // 股東回饋以獨立長條並列，不做「扣除後餘額」這類自創的差額。
      const steps = [
        { label: "營業現金流", value: disp(ocf.c), type: "total" },
        { label: "資本支出", value: disp(capex.c), type: "use" },
      ];
      if (fcfStated !== null) steps.push({ label: "自由現金流", value: disp(fcfStated), type: "total" });
      if (buy.c) steps.push({ label: "庫藏股買回", value: disp(buy.c), type: "bar", group: "股東回饋" });
      if (div.c) steps.push({ label: "現金股利", value: disp(div.c), type: "bar", group: "股東回饋" });
      const shown = steps.filter((s) => s.value !== null && s.value !== undefined);
      if (shown.length) cards.push({
        id: "G", template: "T5", header: { ...header, label: "現金流量與股東回饋" }, source: `${baseSource}。${fcfStated !== null ? "自由現金流為公司公布的非 GAAP 數字。" : ""}`,
        body: { unit: unitText, kind: "amount", steps: shown },
      });
    }
  }

  // K1：公司下季財測＋公司明確寫出的財測調整。兩者都沒有就不產出 K1（不顯示「未提供」）。
  const curShort = profile.defaults.display_currency;
  const STD_NAMES = { revenue: "營收", operating_income: "營業利益", operating_margin: "營益率", gross_margin: "毛利率", eps: "EPS", free_cash_flow: "自由現金流" };
  const labelOf = (it, path) => {
    let zh = STD_NAMES[it.metric] || useName(nameOf(it, path, ctx));
    // 財測的 EPS 口徑依原文名稱（Diluted／Basic）；原文沒寫就只寫 EPS，不推定
    if (it.metric === "eps") zh = /dilut|稀釋/i.test(it.label_source) ? "稀釋 EPS" : /basic|基本/i.test(it.label_source) ? "基本 EPS" : "EPS";
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

  const gRows = [];
  if (g && g.items.length) for (const it of g.items) gRows.push({ label: labelOf(it, `guidance_next.items[${it.metric}|${it.label_source}]`), value: showItem([it], it.unit, guidanceScale)[0] });

  const revRows = [];
  for (const r of fs.guidance_revisions || []) {
    const scale = Math.pow(10, UNIT_POWER[r.monetary_unit] ?? srcPow);
    const diff = mid(r.current) - mid(r.previous);
    const period = /Q[1-4]$/.test(r.period_label) ? fiscalToCalendar(r.period_label, company.fiscal_year_end_month || 12) : r.period_label;
    const [previous, current] = showItem([r.previous, r.current], r.unit, scale);
    revRows.push({ label: labelOf(r, `guidance_revisions[${r.metric}|${r.label_source}]`), period, previous, current, previousDate: r.previous_date || null, dir: diff > 0 ? "up" : diff < 0 ? "down" : "flat" });
  }

  if (gRows.length || revRows.length) {
    const sections = [];
    // 財測調整：期間相同時寫在標題（例如「財測調整（FY2026）」），不同時才寫在每一列
    const periods = [...new Set(revRows.map((r) => r.period))];
    const revTitle = `財測調整${periods.length === 1 ? `（${periods[0]}）` : ""}`;
    const dates = [...new Set(revRows.map((r) => r.previousDate))];
    const prevDate = dates.length === 1 ? dates[0] : null;
    if (gRows.length) sections.push({ heading: "", columns: ["項目", "財測"], rows: gRows });
    if (revRows.length) sections.push({
      // 欄名固定為「前次財測／本次財測」（不用「調整前／調整後」，避免和 Adjusted 指標混淆）；
      // 原文有前次財測的發布日期、且每一列都是同一天時，附在欄名後，例如「前次財測（7/17）」
      heading: gRows.length ? revTitle : "", columns: ["項目", `前次財測${prevDate ? `（${prevDate}）` : ""}`, "本次財測"],
      rows: revRows.map((r) => ({ cells: [periods.length === 1 ? r.label : `${r.label}｜${r.period}`, r.previous, { arrow: r.dir, value: r.current }] })),
    });
    if (company.next_report_date) sections.push({ heading: "下次財報日期", columns: ["日期", "事件"], rows: [{ label: company.next_report_date, value: "下一季財報公布（公司公告）", text: true }] });
    cards.push({
      id: "K1", template: "T8", header: { ...header, label: gRows.length ? "下季財測" : "財測調整" }, source: `${baseSource}。`,
      title: gRows.length ? `公司下季財測（${fiscalToCalendar(g.period_label, company.fiscal_year_end_month || 12)}）` : `公司${revTitle}`,
      body: { sections },
    });
  }

  if (overridden("gross_profit_identity")) dropped.push("毛利節點與毛利率（毛利勾稽不符，使用者確認原文如此）");
  selection.dropped = dropped;
  if (stopAtOI) for (let i = derived.length - 1; i >= 0; i--) if (derived[i].startsWith("業外")) derived.splice(i, 1);
  // 圖卡上用到的 AI 譯名與缺少中文名稱的科目：由核對畫面列入第三層（origin：ai／missing）
  const labels = [...labelsUsed.values()];
  return { checks, derived, derivable, labels, metrics: M, selection, cards, units: { source: m.monetary_unit, display: unitText, srcPow, dispPow }, revenueDisplay: disp(rev.c) };
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
  const chosen = triggers.deck.selection_priority.filter((c) => fired[c] && canBuild(c)).slice(0, triggers.deck.max_conditional);
  const unbuilt = Object.keys(fired).filter((c) => !canBuild(c));
  const order = triggers.deck.order_on_deck;
  const deck = order.filter((c) => triggers.deck.fixed.includes(c) || chosen.some((x) => x.split(":")[0] === c));
  return { fired, skipped, chosen, deck, unbuilt };
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
        if (["src", "extraction", "ambiguities", "comment", "key", "label_source", "label_zh", "unit", "metric"].includes(k)) continue;
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
  const raw = diffExtractions(a, b).filter((d) => !/^stated_metrics|^market_specific/.test(d.path) && !(d.a === null && d.b === null));
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
