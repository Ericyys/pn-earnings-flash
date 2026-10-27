// 計算層：數據表 → 自動檢查 → 指標 → 選圖 → 圖卡 spec
// 純計算，不碰畫面；瀏覽器與 Node 都能執行。
//
// analyze(fs, ctx) 回傳：
//   checks    自動檢查結果（pass／fail／warn／skip）
//   derived   由 PN 計算、原文沒有直接列出的數字（必須在圖卡來源行註明）
//   metrics   指標（年增率、利潤率、佔比…）
//   selection 這次做哪幾張、哪些規則觸發、哪些因資料不足略過
//   cards     給底稿的 spec（A1、C、條件模組、K1）
//   confirm   需要人工確認的項目（核對畫面會逐項列出）

const MINUS = "−";

// ───────── 小工具 ─────────
const num = (dp) => (dp && typeof dp.value === "number" ? dp.value : null);
const cur = (pair) => num(pair?.current);
const pri = (pair) => num(pair?.prior_year);
const yoy = (a, b) => (a !== null && b !== null && b !== 0 ? (a / Math.abs(b) - Math.sign(b)) * 100 : null);
const pctOf = (a, b) => (a !== null && b !== null && b !== 0 ? (a / b) * 100 : null);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const decimalsOf = (v) => { const s = String(v); return s.includes(".") ? s.split(".")[1].length : 0; };

const UNIT_POWER = { ones: 0, thousands: 3, millions: 6, billions: 9 };
const DISPLAY_POWER = { billions: 9, hundred_millions: 8, millions: 6 };
const DISPLAY_LABEL = { billions: "B", hundred_millions: "億", millions: "M" };

/** 依標籤正規化，用來辨識「營業成本」等列 */
const norm = (s) => String(s || "").toLowerCase().replace(/[*:：]/g, "").replace(/\s+/g, " ").trim();

function zhLabel(src, ctx) {
  const n = norm(src);
  return ctx.labels?.[n] || src;
}

// ───────── 主函式 ─────────
export function analyze(fs, ctx) {
  const { profile, company = {}, triggers, history = [] } = ctx;
  const checks = [];
  const derived = [];
  const confirm = [];
  const add = (id, label, status, detail = "") => checks.push({ id, label, status, detail });

  const m = fs.meta;
  const IS = fs.income_statement;
  const srcPow = UNIT_POWER[m.monetary_unit] ?? 6;
  const dispUnit = profile.defaults.display_unit;
  const dispPow = DISPLAY_POWER[dispUnit];
  const toDisp = (v) => (v === null ? null : v * Math.pow(10, srcPow - dispPow));
  const unitText = `${profile.defaults.display_currency} ${DISPLAY_LABEL[dispUnit]}`;
  const tol = (terms = 1) => Math.max(1, terms); // 四捨五入容許：原文最小單位 × 項數

  // ── 1. 基本設定：一律需要人工確認
  confirm.push({ level: 1, items: ["company_name", "fiscal_period", "period_end", "monetary_unit", "currency", "accounting_basis"].map((k) => ({ field: `meta.${k}`, value: m[k] })) });

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
    items.push({ key: it.key, label: it.label_source, zh: zhLabel(it.label_source, ctx), c: Math.abs(c), p: p === null ? null : Math.abs(p) });
  }
  if (cogs.c !== null) cogs = { c: Math.abs(cogs.c), p: cogs.p === null ? null : Math.abs(cogs.p) };

  const rev = { c: cur(IS.revenue), p: pri(IS.revenue) };
  const oi = { c: cur(IS.operating_income), p: pri(IS.operating_income) };
  const pretax = { c: cur(IS.pretax_income), p: pri(IS.pretax_income) };
  const ni = { c: cur(IS.net_income), p: pri(IS.net_income) };
  const niP = { c: cur(IS.net_income_to_parent) ?? ni.c, p: pri(IS.net_income_to_parent) ?? ni.p };
  const other = { c: cur(IS.other_operating_net) ?? 0, p: pri(IS.other_operating_net) ?? 0 };
  const opexTotal = { c: cur(IS.operating_expenses_total), p: pri(IS.operating_expenses_total) };

  // ── 3. 毛利：原文有就用；沒有但有營業成本 → 由 PN 計算並註明
  let gp = { c: cur(IS.gross_profit), p: pri(IS.gross_profit) };
  if (gp.c !== null && cogs.c !== null) {
    const d = rev.c - cogs.c - gp.c;
    add("gross_profit_identity", "毛利＝營收−營業成本", Math.abs(d) <= tol(2) ? "pass" : "fail", `差 ${d}`);
  } else if (gp.c === null && cogs.c !== null) {
    gp = { c: rev.c - cogs.c, p: rev.p !== null && cogs.p !== null ? rev.p - cogs.p : null };
    derived.push("毛利（營收−營業成本）");
    add("gross_profit_identity", "毛利＝營收−營業成本", "skip", "原文未列毛利，由 PN 計算");
  } else {
    add("gross_profit_identity", "毛利＝營收−營業成本", "skip", "公司沒有營業成本／毛利（例如金融業）");
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

  // ── 5. 業外：原文沒有合計 → 稅前−營業利益，由 PN 計算並註明
  let nonop = { c: cur(IS.non_operating_net), p: pri(IS.non_operating_net) };
  if (nonop.c === null && pretax.c !== null && oi.c !== null) {
    nonop = { c: pretax.c - oi.c, p: pretax.p !== null && oi.p !== null ? pretax.p - oi.p : null };
    derived.push("業外收支淨額（稅前淨利−營業利益）");
    add("pretax_identity", "稅前淨利＝營業利益＋業外", "skip", "原文未列業外合計，由 PN 計算");
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

  // ── 7. EPS 勾稽（股數與金額單位可能不同）
  const shPow = UNIT_POWER[m.share_unit] ?? srcPow;
  const epsCalc = (k) => {
    const sh = k === "c" ? cur(IS.shares_diluted) : pri(IS.shares_diluted);
    return niP[k] !== null && sh ? (niP[k] * Math.pow(10, srcPow)) / (sh * Math.pow(10, shPow)) : null;
  };
  const eps = { c: cur(IS.eps_diluted), p: pri(IS.eps_diluted) };
  for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
    const e = epsCalc(k);
    if (e === null || eps[k] === null) { add(`eps_identity_${k}`, `${lab}：EPS≈淨利÷稀釋股數`, "skip"); continue; }
    add(`eps_identity_${k}`, `${lab}：EPS≈淨利÷稀釋股數`, Math.abs(e - eps[k]) <= 0.01 ? "pass" : "fail", `計算 ${e.toFixed(4)}，原文 ${eps[k]}`);
  }

  // ── 8. 營收拆分加總（同時偵測單位不一致）
  function sumCheck(list, name) {
    if (!list || !list.length) return add(`${name}_sum`, `${name === "segments" ? "部門" : "地區"}加總＝營收`, "skip", "無資料");
    const items2 = list.filter((s) => s.revenue);
    if (!items2.length) return add(`${name}_sum`, "拆分加總", "skip", "只有百分比");
    for (const [k, lab] of [["c", "本季"], ["p", "去年同期"]]) {
      const s = items2.reduce((a, x) => a + (k === "c" ? cur(x.revenue) : pri(x.revenue)) || 0, 0);
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
  M.gross_margin = pctOf(gp.c, rev.c); M.gross_margin_p = pctOf(gp.p, rev.p);
  M.operating_margin = pctOf(oi.c, rev.c); M.operating_margin_p = pctOf(oi.p, rev.p);
  M.net_margin = pctOf(niP.c, rev.c); M.net_margin_p = pctOf(niP.p, rev.p);
  M.gross_margin_change_pp_yoy = M.gross_margin !== null && M.gross_margin_p !== null ? M.gross_margin - M.gross_margin_p : null;
  M.operating_margin_change_pp_yoy = M.operating_margin !== null && M.operating_margin_p !== null ? M.operating_margin - M.operating_margin_p : null;
  M.net_margin_change_pp_yoy = M.net_margin !== null && M.net_margin_p !== null ? M.net_margin - M.net_margin_p : null;
  // EPS 年增率：用未四捨五入的「淨利÷股數」，與公司自己的算法一致
  const eu = { c: epsCalc("c"), p: epsCalc("p") };
  M.eps_yoy = yoy(eu.c, eu.p);
  M.eps_yoy_from_rounded = yoy(eps.c, eps.p);
  M.operating_income_yoy = yoy(oi.c, oi.p);
  M.net_income_yoy = yoy(niP.c, niP.p);

  // 季變動：原文有上一季欄位（prior_quarter）或歷史存檔時才算
  const last = history.length ? history[history.length - 1] : null;
  const pq = (pair) => num(pair?.prior_quarter);
  const revQ = pq(IS.revenue), oiQ = pq(IS.operating_income), niQ = pq(IS.net_income_to_parent) ?? pq(IS.net_income);
  const cogsQ = pq(IS.cost_of_revenue) ?? (fs.operating_expense_items || []).filter((it) => cogsAliases.includes(norm(it.label_source))).map((it) => pq(it.amount))[0] ?? null;
  const gpQ = pq(IS.gross_profit) ?? (revQ !== null && cogsQ !== null ? revQ - Math.abs(cogsQ) : null);
  M.gross_margin_q = pctOf(gpQ, revQ); M.operating_margin_q = pctOf(oiQ, revQ); M.net_margin_q = pctOf(niQ, revQ);
  M.gross_margin_change_pp_qoq = M.gross_margin !== null && M.gross_margin_q !== null ? M.gross_margin - M.gross_margin_q : null;
  M.operating_margin_change_pp_qoq = M.operating_margin !== null && M.operating_margin_q !== null ? M.operating_margin - M.operating_margin_q : null;
  M.net_margin_change_pp_qoq = M.net_margin !== null && M.net_margin_q !== null ? M.net_margin - M.net_margin_q : null;
  M.revenue_qoq = yoy(rev.c, revQ);
  M.margin_8q_extreme = history.length >= 7 ? null : null;

  // 拆分指標
  function breakdown(list) {
    if (!list || !list.length) return null;
    const rows = list.filter((s) => s.revenue).map((s) => {
      const c = cur(s.revenue), p = pri(s.revenue);
      const meta = (company.geographies || []).concat(company.segments || []).find((x) => x.key === s.key);
      return { key: s.key, name: meta?.label_zh || s.label_source, c, p, share: pctOf(c, rev.c), share_p: pctOf(p, rev.p), yoy: yoy(c, p), reconciling: meta?.reconciling };
    });
    const main = rows.filter((r) => !r.reconciling);
    return {
      rows,
      maxShareChange: Math.max(...main.map((r) => Math.abs((r.share ?? 0) - (r.share_p ?? 0)))),
      maxYoyGap: Math.max(...main.map((r) => Math.abs((r.yoy ?? 0) - (M.revenue_yoy ?? 0)))),
    };
  }
  const seg = breakdown(fs.segments), geo = breakdown(fs.geographies);
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
  M.capex_yoy = cfIsQuarter ? yoy(capex.c, capex.p) : null;
  M.capital_return_yoy = cfIsQuarter && (buy.c !== null || div.c !== null) ? yoy((buy.c || 0) + (div.c || 0), (buy.p || 0) + (div.p || 0)) : null;
  M.buybacks_yoy = cfIsQuarter ? yoy(buy.c, buy.p) : null;
  M.new_buyback_authorization = !!cr.new_buyback_authorization;
  if (cr.new_buyback_authorization) confirm.push({ level: 2, items: [{ field: "capital_return.new_buyback_authorization", value: cr.new_buyback_authorization.amount?.value, note: "確認原文是「新授權」而非「剩餘額度」，並確認單位" }] });
  const fcfStated = cur(cf.free_cash_flow_stated);
  if (fcfStated !== null && ocf.c !== null && capex.c !== null) {
    const d = ocf.c - capex.c - fcfStated;
    add("fcf_identity", "自由現金流＝營業現金流−資本支出", Math.abs(d) <= tol(2) ? "pass" : "warn", `差 ${d}（公司定義可能不同）`);
  }

  // ── 10. 公司自己寫出的比率 → 驗證 PN 的計算（容許值依原文精度）
  const statedMap = { revenue_yoy: M.revenue_yoy, operating_margin: M.operating_margin, gross_margin: M.gross_margin, net_margin: M.net_margin, eps_yoy: M.eps_yoy, revenue_qoq: M.revenue_qoq };
  for (const s of fs.stated_metrics || []) {
    if (!(s.metric in statedMap) || statedMap[s.metric] === null) continue;
    const calc = statedMap[s.metric];
    const allow = 0.5 * Math.pow(10, -decimalsOf(s.value)) + 0.05;
    const ok = Math.abs(calc - s.value) <= allow;
    add(`stated_${s.metric}_${s.value}`, `原文寫 ${s.metric} ${s.value}${s.unit === "percent" ? "%" : ""}`, ok ? "pass" : "fail", `PN 計算 ${calc.toFixed(2)}`);
  }
  if (M.eps_yoy !== null && M.eps_yoy_from_rounded !== null && Math.abs(M.eps_yoy - M.eps_yoy_from_rounded) >= 0.5) {
    add("eps_yoy_rounding", "EPS 年增率的算法", "warn", `用四捨五入後的 EPS 算是 ${M.eps_yoy_from_rounded.toFixed(1)}%，用淨利÷股數算是 ${M.eps_yoy.toFixed(1)}%；圖卡採後者（與公司一致）`);
  }

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
    add("guidance_unit", "財測金額單位", g.monetary_unit === m.monetary_unit ? "pass" : "warn", `財測單位 ${g.monetary_unit}，報表單位 ${m.monetary_unit}，已換算；請人工確認`);
  } else if (g && g.items.length) {
    const gRev = g.items.find((x) => x.metric === "revenue");
    const gv = gRev ? (gRev.point ?? (gRev.low + gRev.high) / 2) : null;
    if (gv && rev.c) {
      const ratio = rev.c / gv; // 正常約 1；差 1000 倍表示財測用較大單位
      const powDiff = Math.round(Math.log10(ratio) / 3) * 3;
      if (powDiff !== 0) {
        guidanceScale = Math.pow(10, srcPow + powDiff);
        add("guidance_unit", "財測金額單位與報表一致", "warn", `財測金額約為報表的 1/${Math.pow(10, powDiff)}，推定單位為 ${Object.keys(UNIT_POWER).find((u) => UNIT_POWER[u] === srcPow + powDiff)}；請人工確認`);
      } else add("guidance_unit", "財測金額單位與報表一致", "pass");
    }
  }

  // ── 13. AI 提出的疑慮：每一條都要人工處理
  if ((fs.ambiguities || []).length) {
    add("ambiguities", "AI 提出的疑慮", "warn", `${fs.ambiguities.length} 條，需逐條確認`);
    confirm.push({ level: 3, items: fs.ambiguities.map((a) => ({ field: a.related_field, note: a.issue })) });
  }

  // ── 14. 選圖
  const selection = selectModules(M, triggers, { hasGuidancePrev: !!last?.guidance_next, consensus: fs.consensus, peers: false });

  // ── 15. 圖卡 spec
  const disp = (v) => toDisp(v);
  const period = fiscalToCalendar(m.fiscal_period, company.fiscal_year_end_month || 12);
  const header = { ticker: m.ticker, period, label: "財報快報" };
  const docName = company.source_doc_name_zh || "財報新聞稿";
  const baseSource = `資料來源：${company.company_name_zh || m.company_name} ${period} ${docName}（${m.report_date}）`;
  const withDerived = (list) => (list.length ? `${baseSource}。${list.join("、")}為 PN 依損益表科目計算。` : `${baseSource}。`);

  const cards = [];
  const name = company.company_name_zh || m.company_name;
  // A1
  cards.push({
    id: "A1", template: "T1", header, source: `${baseSource}。`,
    body: {
      ticker: m.ticker, company: name, period,
      headline: `營收 ${unitText.split(" ")[0]} ${fmt2(disp(rev.c))}${DISPLAY_LABEL[dispUnit]}，年增 ${fmt1(M.revenue_yoy)}%`,
      kpis: [
        { label: "營收", unit: unitText, value: disp(rev.c), kind: "amount", delta: { value: M.revenue_yoy, kind: "pct", label: "年增" }, note: `去年同期 ${fmt2(disp(rev.p))}` },
        { label: "營益率", unit: "%", value: M.operating_margin, kind: "pct", delta: { value: M.operating_margin_change_pp_yoy, kind: "pp", label: "年變動" }, note: `去年同期 ${fmt1(M.operating_margin_p)}%` },
        { label: "稀釋 EPS", unit: profile.defaults.display_currency, value: eps.c, kind: "perShare", delta: { value: M.eps_yoy, kind: "pct", label: "年增" }, note: `去年同期 ${eps.p?.toFixed(2)}` },
      ],
    },
  });

  // C
  const highlight = triggers.modules.C.annotations[0];
  const hl = evalCond(highlight.when, M).value;
  cards.push({
    id: "C", template: "T4", header: { ...header, label: "損益流向" },
    source: withDerived(derived),
    body: {
      unit: unitText,
      revenue: disp(rev.c), cogs: disp(cogs.c ?? 0), grossProfit: disp(gp.c ?? rev.c),
      opex: items.map((it) => ({ name: it.zh, value: disp(it.c) })),
      otherOperating: disp(other.c || 0), operatingIncome: disp(oi.c),
      nonOperating: disp(nonop.c || 0), tax: disp(tax.c ?? 0), netIncome: disp(niP.c),
      margins: { gross: gp.c !== null && cogs.c !== null ? M.gross_margin : undefined, operating: M.operating_margin, net: M.net_margin },
      note: hl ? (fs.notable_items?.length ? fs.notable_items.map((x) => `${x.label_source} ${fmt2(disp(num(x.amount)))}`).join("；") : `業外收支淨額佔淨利 ${fmt1(M.non_operating_share_of_net_income * 100)}%`) : undefined,
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
      const pick = [["營益率", M.operating_margin, M.operating_margin_change_pp_yoy], ["毛利率", M.gross_margin, M.gross_margin_change_pp_yoy], ["淨利率", M.net_margin, M.net_margin_change_pp_yoy]]
        .filter((x) => x[2] !== null && (x[0] !== "毛利率" || cogs.c !== null))
        .sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]))[0];
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
      const src = seg && M.segment_share_change_pp_yoy !== null ? seg : geo;
      const label = src === seg ? "業務" : "地區";
      const top = [...src.rows].sort((a, b) => Math.abs((b.share - b.share_p)) - Math.abs((a.share - a.share_p)))[0];
      cards.push({
        id: "B", template: "T2", header: { ...header, label: src === seg ? "營收組成" : "各地區營收" }, source: `${baseSource}。`,
        body: {
          unit: unitText, kind: "amount", periods: [shiftYear(period, -1), period],
          series: src.rows.map((r) => ({ name: r.name, values: [disp(r.p), disp(r.c)] })),
          yoy: src.rows.map((r) => r.yoy),
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
      const cand = [["資本支出", capex.c, M.capex_yoy], ["庫藏股買回", buy.c, M.buybacks_yoy]].filter((x) => x[2] !== null);
      const t = cand.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]))[0];
      const auth = cr.new_buyback_authorization;
      const gTitle = t
        ? `${t[0]} ${unitText.split(" ")[0]} ${fmt2(disp(t[1]))}${DISPLAY_LABEL[dispUnit]}，年${t[2] >= 0 ? "增" : "減"} ${fmt1(Math.abs(t[2]))}%`
        : `新增庫藏股買回授權 ${fmt2(disp(num(auth?.amount)))}（待人工確認單位）`;
      cards.push({
        id: "G", template: "T5", header: { ...header, label: "現金流量與股東回饋" }, source: `${baseSource}。${fcfStated !== null ? "自由現金流為公司公布的非 GAAP 數字。" : ""}`,
        body: { unit: unitText, kind: "amount", steps },
      });
    }
  }

  // K1
  const gRows = [];
  if (g && g.items.length) {
    const toD = (v) => (v === null || v === undefined ? null : (v * guidanceScale) / Math.pow(10, dispPow));
    const show = (it) => {
      const v = (x) => (it.unit === "monetary" ? fmt2(toD(x)) : it.unit === "percent" ? `${fmt1(x)}%` : it.unit === "per_share" ? Number(x).toFixed(2) : String(x));
      return it.point !== null && it.point !== undefined ? v(it.point) : `${v(it.low)}–${v(it.high)}`;
    };
    const names = { revenue: `營收（${unitText}）`, operating_income: `營業利益（${unitText}）`, operating_margin: "營益率", gross_margin: "毛利率", eps: `稀釋 EPS（${profile.defaults.display_currency}）` };
    // 公司給的每一項都列出（忠實呈現），沒有標準代號的用中文對照或原文名稱
    for (const it of g.items) {
      let label = names[it.metric];
      if (!label) {
        const zh = zhLabel(it.label_source, ctx);
        label = it.unit === "monetary" ? `${zh}（${unitText}）` : it.unit === "per_share" ? `${zh}（${profile.defaults.display_currency}）` : zh;
      }
      gRows.push({ label, value: show(it) });
    }
  }
  cards.push({
    id: "K1", template: "T8", header: { ...header, label: "下季財測" }, source: `${baseSource}。`,
    title: gRows.length ? `公司下季財測（${fiscalToCalendar(g.period_label, company.fiscal_year_end_month || 12)}）` : "公司下季財測",
    body: {
      // 只放公司公布的內容，不加預告或其他資訊（小組決定，2026-10-27）
      sections: [
        gRows.length
          ? { heading: "", columns: ["項目", "財測"], rows: gRows }
          : { heading: "", columns: ["項目", "內容"], rows: [{ label: "下季財測", value: "公司本次未提供", text: true }] },
        ...(company.next_report_date ? [{ heading: "下次財報日期", columns: ["日期", "事件"], rows: [{ label: company.next_report_date, value: "下一季財報公布（公司公告）", text: true }] }] : []),
      ],
    },
  });

  return { checks, derived, metrics: M, selection, cards, confirm, units: { source: m.monetary_unit, display: unitText } };
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
  const chosen = triggers.deck.selection_priority.filter((c) => fired[c]).slice(0, triggers.deck.max_conditional);
  const order = triggers.deck.order_on_deck;
  const deck = order.filter((c) => triggers.deck.fixed.includes(c) || chosen.some((x) => x.split(":")[0] === c));
  return { fired, skipped, chosen, deck };
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
const fmt1 = (v) => (v === null || v === undefined ? "—" : (Math.round(v * 10) / 10).toFixed(1).replace("-", MINUS));
const fmt2 = (v) => (v === null || v === undefined ? "—" : (Math.round(v * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",").replace("-", MINUS));

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
        if (["src", "extraction", "ambiguities", "comment", "key", "label_source", "unit", "metric"].includes(k)) continue;
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
    if (!groups.has(key)) groups.set(key, { path: key, a: [], b: [], type: d.type });
    const g = groups.get(key);
    g.a.push(tagZh ? `${tagZh} ${d.a}` : d.a);
    g.b.push(tagZh ? `${tagZh} ${d.b}` : d.b);
  }
  return [...groups.values()].map((g) => ({ ...g, a: g.a.join("；"), b: g.b.join("；") }));
}

/** 貼上的文字 → JSON：自動去掉 ```json 程式碼框 */
export function parseFactSheet(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}
