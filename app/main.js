// PN 財報快報｜出圖工具（頁面邏輯）
// 流程：1 貼上數據 → 2 自動檢查 → 3 人工核對（可修改、可交給 AI）→ 4 產出圖卡、下載 PNG 與本季存檔
// 計算在 lib/compute.js、修改在 lib/review.js、畫圖在 templates/，這裡只負責畫面與狀態。

export const APP_VERSION = "1.0.0（2026-10-28）";

import { analyze, parseFactSheet, diffForReview } from "./lib/compute.js";
import { validate } from "./lib/validate.js";
import { renderCard } from "./templates/index.js";
import { createMeasurer } from "./lib/text.js";
import { ensureFonts, installLocalAliases } from "./lib/fonts.js";
import { svgToPng, download } from "./lib/export.js";
import { applyEdits, getNode, periodColumnCheck, correctionPrompt } from "./lib/review.js";

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const getJSON = async (p) => { const r = await fetch(p); if (!r.ok) throw new Error(`讀取失敗：${p}`); return r.json(); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fatal = (msg) => { $("fatal").hidden = false; $("fatal").innerHTML = msg; };
$("appVersion").textContent = `版本 ${APP_VERSION}`;

// ───── 載入設定檔（任何一個讀不到，就顯示錯誤並停止，不讓使用者在缺設定的狀態下操作）
let brand, fontCss, schema, triggers, labels, profiles;
try {
  brand = await getJSON("./brand.json");
  fontCss = q.get("fontcss") || brand.fonts.web_source;   // 本機測試可指定替代字型表
  if (q.get("local") === "1") installLocalAliases(); else $("gf").href = brand.fonts.web_source;
  [schema, triggers, labels, profiles] = await Promise.all([
    getJSON("../schema/fact_sheet.schema.json"),
    getJSON("../rules/triggers.json"),
    getJSON("../references/labels_zh.json").then((d) => d.labels),
    Promise.all([getJSON("../profiles/us.json"), getJSON("../profiles/tw.json")]).then(([us, tw]) => ({ us, tw })),
  ]);
  const companyList = (await getJSON("../companies/index.json")).companies;
  for (const c of companyList) $("company").insertAdjacentHTML("beforeend", `<option value="${esc(c.path)}">${esc(c.label)}</option>`);
} catch (e) {
  fatal(`<b class="fail">工具載入失敗：${esc(e.message)}</b><br>請確認 GitHub 上的檔案完整（app、schema、rules、profiles、references、companies 資料夾都在），再重新整理頁面。`);
  $("btnCheck").disabled = true;
  throw e;
}

let state = { ticks: new Set(), choices: {}, edits: [], rounds: 0 };
let measure = null;

// 檔案上傳 → 填入文字框
for (const k of ["A", "B"]) {
  $(`file${k}`).addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) $(`fs${k}`).value = await f.text(); });
}

// ───── 步驟 1 → 2
$("btnCheck").onclick = async () => {
  try { await runCheck(); }
  catch (e) { console.error(e); $("s1msg").innerHTML = `<span class="fail">檢查時發生錯誤：${esc(e.message)}。請確認貼上的是完整的 JSON，或把這段訊息截圖給維護者。</span>`; }
};

async function runCheck() {
  $("s1msg").textContent = "";
  ["s2", "s3", "s4"].forEach((id) => ($(id).hidden = true));
  let A, B = null;
  try { A = parseFactSheet($("fsA").value); } catch (e) { $("s1msg").innerHTML = `<span class="fail">A 不是有效的 JSON：${esc(e.message)}</span>`; return; }
  if ($("fsB").value.trim()) {
    try { B = parseFactSheet($("fsB").value); } catch (e) { $("s1msg").innerHTML = `<span class="fail">B 不是有效的 JSON：${esc(e.message)}</span>`; return; }
  }
  const company = $("company").value ? await getJSON(`../companies/${$("company").value}`) : {};
  const errA = validate(schema, A), errB = B ? validate(schema, B) : [];

  // 同一家公司、同一季重新貼上（例如 AI 依修正要求重新輸出）→ 沿用上一輪的核對紀錄
  const prev = state.A && state.A.meta?.ticker === A.meta?.ticker && state.A.meta?.fiscal_period === A.meta?.fiscal_period ? state : null;
  state = { A, B, company, errA, errB, ticks: new Set(), choices: {}, edits: [], rounds: prev ? prev.rounds + 1 : 0, editing: null };
  let carry = "";
  if (prev) {
    // 修改：AI 已照修正要求改好 → 不必再套用；AI 沒改 → 繼續套用；AI 改成別的值 → 丟棄，該項需重新核對
    let kept = 0, absorbed = 0, dropped = 0;
    for (const e of prev.edits) {
      const now = getNode(A, e.path);
      const nowV = e.kind === "datapoint" ? now?.value : now;
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      if (same(nowV, e.value)) absorbed++;
      else if (same(nowV, e.ai)) { state.edits.push(e); kept++; }
      else dropped++;
    }
    state.ticks = new Set(prev.ticks);
    for (const [id, ch] of Object.entries(prev.choices)) if (ch.choice !== "ai") state.choices[id] = ch;
    carry = `沿用上一輪的核對紀錄：勾選 ${prev.ticks.size} 項（數值有變的會自動取消）、修改 ${kept} 項仍需套用、${absorbed} 項 AI 已照改、${dropped} 項 AI 改成其他值（需重新核對）、判斷 ${Object.keys(state.choices).length} 項。`;
  }
  $("carryMsg").innerHTML = carry ? `<div class="banner ok">${esc(carry)}</div>` : "";
  $("general").value = "";

  const fmtList = (name, errs) => errs.length
    ? `<div class="banner"><b class="fail">${name} 格式有 ${errs.length} 處錯誤</b><ul>${errs.slice(0, 20).map((e) => `<li><code>${esc(e.path || "（最上層）")}</code>：${esc(e.message)}</li>`).join("")}</ul></div>`
    : `<div class="banner ok"><b class="pass">${name} 格式通過</b></div>`;
  $("formatBox").innerHTML = `<h3>格式</h3>${fmtList("A", errA)}${B ? fmtList("B", errB) : ""}`;
  $("s2").hidden = false;
  if (errA.length) {
    $("formatBox").insertAdjacentHTML("beforeend", `<p class="pad">A 的格式錯誤必須先修正：把錯誤訊息貼回給 AI，請它修正後重新輸出，再貼回來檢查。</p>`);
    $("checks").querySelector("tbody").innerHTML = ""; $("diffBox").innerHTML = "";
    return;
  }
  state.profile = profiles[A.meta.market] || profiles.us;
  recompute();
  $("s3").hidden = false;
  $("s3").scrollIntoView({ behavior: "smooth" });
}

// ───── 重新計算：套用修改與覆寫 → 自動檢查 → 核對清單（每次修改後整份重算，所有圖卡用同一份數據）
function recompute() {
  const { fs: Aeff, failed } = applyEdits(state.A, state.edits);
  state.Aeff = Aeff;
  const overrides = Object.entries(state.choices).filter(([id, ch]) => id.startsWith("check:") && ch.choice === "ok").map(([id]) => id.slice(6));
  state.out = analyze(Aeff, { profile: state.profile, company: state.company, triggers, labels, history: [], overrides });
  state.diffs = state.B ? diffForReview(Aeff, state.B) : [];
  const lab = { pass: "通過", fail: "不通過", warn: "需確認", skip: "略過" };
  $("checks").querySelector("tbody").innerHTML = state.out.checks.map((c) =>
    `<tr><td class="${c.status}">${lab[c.status]}</td><td>${esc(c.label)}</td><td>${esc(c.detail)}</td></tr>`).join("");
  $("diffBox").innerHTML = state.B ? `<h3>A／B 比對：${state.diffs.length} 處不同</h3>
    <p class="pad note">差異列在步驟 3 第三層，每一處選擇採用哪一邊。只用於驗算的欄位不列入。</p>` : "";
  if (failed.length) $("diffBox").insertAdjacentHTML("beforeend", `<div class="banner">有 ${failed.length} 筆修改找不到對應欄位，未套用：${esc(failed.map((f) => f.path).join("、"))}</div>`);
  buildManual();
}

// ───── 核對清單
const FIELD_ZH = {
  revenue: "營收", cost_of_revenue: "營業成本", gross_profit: "毛利", operating_income: "營業利益",
  pretax_income: "稅前淨利", income_tax: "所得稅", net_income: "淨利", net_income_to_parent: "歸屬母公司淨利",
  eps_diluted: "稀釋 EPS", shares_diluted: "稀釋股數", non_operating_net: "業外收支淨額", operating_expenses_total: "營業費用合計",
  operating_cash_flow: "營業現金流", capex: "資本支出", free_cash_flow_stated: "自由現金流（公司公布）",
  buybacks: "庫藏股買回", dividends_paid: "現金股利",
};
const PERIOD_ZH = { current: "本季", prior_year: "去年同期", prior_quarter: "上季" };
const PTYPE_ZH = { quarter: "單季", ytd: "累計", point_in_time: "時點" };
const srcText = (s) => !s ? "（無出處）" : `p.${s.page}｜${s.row_label ? `${s.row_label}｜${s.column_label}` : `「${s.quote}」`}`;
const fmtNum = (v) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : v === null ? "（空）" : v === undefined ? "（未標示）" : String(v));
const editOf = (path) => state.edits.find((e) => e.path === path);
const META_FIELDS = [
  ["company_name", "公司", "text"], ["ticker", "代號", "text"], ["fiscal_period", "會計期間（公司財年）", "text"], ["period_end", "期末日", "text"],
  ["monetary_unit", "金額單位", ["ones", "thousands", "millions", "billions"]], ["share_unit", "股數單位", ["ones", "thousands", "millions"]],
  ["currency", "幣別", "text"], ["accounting_basis", "會計準則", ["US GAAP", "IFRS", "other"]],
];

function layer2Items() {
  const A = state.Aeff;
  const unit = A.meta.monetary_unit;
  const items = [];
  const addPair = (group, name, base, pair, u = unit) => {
    if (!pair) return;
    for (const p of ["current", "prior_year", "prior_quarter"]) {
      const dp = pair[p];
      if (dp && (typeof dp.value === "number" || editOf(`${base}.${p}`))) {
        items.push({ group, name: `${name}｜${PERIOD_ZH[p]}${dp.period_type && dp.period_type !== "quarter" ? `（${PTYPE_ZH[dp.period_type]}）` : ""}`, path: `${base}.${p}`, kind: "datapoint", value: dp.value, ptype: dp.period_type || "quarter", unit: u, src: dp.src });
      }
    }
  };
  for (const k of ["revenue", "cost_of_revenue", "gross_profit", "operating_income", "non_operating_net", "pretax_income", "income_tax", "net_income", "net_income_to_parent", "eps_diluted", "shares_diluted"]) {
    addPair("損益表", FIELD_ZH[k], `income_statement.${k}`, A.income_statement[k], k === "eps_diluted" ? "每股" : k === "shares_diluted" ? `股（${A.meta.share_unit}）` : unit);
  }
  for (const it of A.operating_expense_items || []) addPair("費用逐列", it.label_source, `operating_expense_items[${it.key}].amount`, it.amount);
  for (const s of A.segments || []) { addPair("部門", s.label_source, `segments[${s.key}].revenue`, s.revenue); addPair("部門佔比", s.label_source, `segments[${s.key}].share_percent`, s.share_percent, "%"); }
  for (const s of A.geographies || []) { addPair("地區", s.label_source, `geographies[${s.key}].revenue`, s.revenue); addPair("地區佔比", s.label_source, `geographies[${s.key}].share_percent`, s.share_percent, "%"); }
  for (const k of A.kpis || []) {
    for (const p of ["current", "prior_year"]) if (k[p] && (typeof k[p].value === "number" || editOf(`kpis[${k.key}].${p}`)))
      items.push({ group: "營運指標", name: `${k.label_source}｜${PERIOD_ZH[p]}`, path: `kpis[${k.key}].${p}`, kind: "datapoint", value: k[p].value, ptype: k[p].period_type || "quarter", unit: k.unit, src: k[p].src });
  }
  for (const [k, v] of Object.entries(A.cash_flow || {})) addPair("現金流量", FIELD_ZH[k] || k, `cash_flow.${k}`, v);
  for (const [k, v] of Object.entries(A.capital_return || {})) if (k !== "new_buyback_authorization" && v) addPair("股東回饋", FIELD_ZH[k] || k, `capital_return.${k}`, v);
  if (A.capital_return?.new_buyback_authorization) {
    const a = A.capital_return.new_buyback_authorization;
    items.push({ group: "股東回饋", name: "新增回購授權（確認原文是「新授權」，不是剩餘額度）", path: "capital_return.new_buyback_authorization.amount", kind: "datapoint", value: a.amount?.value, ptype: "point_in_time", unit, src: a.amount?.src, removable: "capital_return.new_buyback_authorization" });
  }
  const g = A.guidance_next;
  if (g) items.push({ group: `下季財測（${g.period_label}）`, name: "財測金額單位（看財測表格或段落的單位說明）", path: "guidance_next.monetary_unit", kind: "unitfield", value: g.monetary_unit ?? "（未標示）", unit: "", src: g.monetary_unit_src });
  if (g) for (const it of g.items) {
    const id = `${it.metric}|${it.label_source}`;
    const range = it.point === null || it.point === undefined;
    items.push({ group: `下季財測（${g.period_label}）`, name: it.label_source, path: `guidance_next.items[${id}]`, kind: "guidance", value: range ? `${it.low}–${it.high}` : it.point,
      unit: it.unit === "monetary" ? (g.monetary_unit || "（未標單位）") : it.unit === "percent" ? "%" : it.unit === "per_share" ? "每股" : "", src: it.src });
  }
  return items;
}

/** 第三層的項目：每一項有固定 id，判斷會跨重算保留 */
function layer3Items() {
  const out = state.out, A = state.Aeff;
  const list = [];
  if (state.choices["meta:period"]) list.push({ id: "meta:period", kind: "period", text: "第一層：期末日與本季數字的出處欄名不是同一期（AI 可能抓錯整欄），工具不允許直接修改" });
  for (const c of out.checks) {
    if (c.status === "fail") list.push({ id: `check:${c.id}`, kind: "fail", text: `不通過：${c.label}｜${c.detail}` });
    if (c.status === "warn" && c.id !== "ambiguities") list.push({ id: `check:${c.id}`, kind: "warn", text: `需確認：${c.label}｜${c.detail}` });
  }
  for (const d of out.derivable) list.push({ id: `derived:${d.id}`, kind: "derived", text: `計算得出的數字：${d.name}＝${d.formula}。原文沒有這一列，依 rules/derivations.json 計算並在圖卡底部註明；請確認原文確實沒有這一列` });
  (A.ambiguities || []).forEach((a, i) => list.push({ id: `amb:${i}:${(a.issue || "").slice(0, 24)}`, kind: "amb", text: `AI 疑慮（${a.related_field || "—"}）：${a.issue}`, path: a.related_field }));
  for (const d of state.diffs) {
    const adoptable = d.paths.every((p) => getNode(A, p) !== undefined && getNode(state.B, p) !== undefined);
    list.push({ id: `diff:${d.path}`, kind: "diff", text: `A／B 不同｜${d.path}｜A＝${d.a}｜B＝${d.b}`, d, adoptable, path: d.path });
  }
  return list;
}

// 三種結果對所有公司都一樣；判斷內容由使用者自己寫
const OUTCOMES = [
  ["ok", "數據正確，不需要修改", ""],
  ["fixed", "我已在第一／二層改正", ""],
  ["ai", "交給 AI 修正", "給 AI 的要求（必填）：例如「單位應為 millions」「請改抓單季欄位」「請補抽地區營收」"],
];
/** 第三層某項是否已處理完：選了「數據正確」或「已改正」（「不通過」選已改正但仍不通過，不算） */
function resolved(it) {
  const ch = state.choices[it.id];
  if (it.kind === "fail" && ch?.choice === "fixed") return false; // 真的改對了，這項會自動消失
  return !!ch && (ch.choice === "ok" || ch.choice === "fixed");
}

// 對「不通過」選「數據正確」時，工具為了不畫出與數字矛盾的圖，會自動少畫的部分
const OVERRIDE_EFFECT = {
  gross_profit_identity: "損益流向圖不畫毛利節點，也不顯示毛利率",
  operating_income_identity_c: "不產出損益流向卡（營業利益與各項費用對不起來，畫出來會互相矛盾）",
  pretax_identity: "損益流向圖只畫到營業利益",
  net_income_identity: "損益流向圖只畫到營業利益",
  segments_sum_c: "不產出營收拆解卡", segments_sum_p: "不產出營收拆解卡",
  geographies_sum_c: "不產出營收拆解卡", geographies_sum_p: "不產出營收拆解卡",
  eps_identity_c: "EPS 年增率改用公司公布的 EPS 相除", eps_identity_p: "EPS 年增率改用公司公布的 EPS 相除",
};
const UNIT_RISK = /^(guidance_magnitude|revenue_amount_|eps_identity_)/;

function buildManual() {
  const A = state.Aeff;
  const blocks = [];
  const tickBox = (key) => `<input type="checkbox" class="mc" data-key="${esc(key)}" ${state.ticks.has(key) ? "checked" : ""}>`;
  const editBtn = (key) => `<button class="ghost small" data-edit="${esc(key)}">修改</button>`;

  // 第一層
  const unitInfo = `→ 圖卡上營收顯示為 ${state.out.units.display.split(" ")[0]} ${(state.out.revenueDisplay ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${state.out.units.display.split(" ")[1]}`;
  blocks.push(`<h3>第一層｜基本設定（錯一欄整份錯）</h3><div class="tablewrap pad"><table><thead><tr><th>✓</th><th>欄位</th><th>值</th><th></th></tr></thead><tbody>
    ${META_FIELDS.map(([f, name, type]) => {
      const path = `meta.${f}`, e = editOf(path), v = A.meta[f], key = `L1|${path}|${v}`;
      const row = `<tr class="${e ? "edited" : ""}"><td>${tickBox(key)}</td><td>${name}</td><td>${esc(v)}${e ? ` <span class="ai-old">AI：${esc(e.ai)}</span>` : ""}${f === "monetary_unit" ? `<div class="note">${esc(unitInfo)}</div>` : ""}</td><td>${editBtn(path)}</td></tr>`;
      return row + (state.editing === path ? editorL1(f, name, type, v) : "");
    }).join("")}</tbody></table></div>`);

  // 第二層
  const items = layer2Items();
  const nEdit2 = state.edits.filter((e) => e.layer === 2).length;
  blocks.push(`<h3>第二層｜數字對原文（${items.length} 項）</h3>
    ${nEdit2 >= 5 ? `<div class="banner">已直接修改 ${nEdit2} 個數字。錯這麼多通常代表 AI 抓錯整欄或整張表，其他沒發現的數字也可能有問題：建議改用「交給 AI 修正」請 AI 重新輸出。</div>` : ""}
    <div class="tablewrap pad"><table><thead><tr><th>✓</th><th>類別</th><th>項目</th><th>數值（原文單位）</th><th>出處：頁｜列名｜欄名</th><th></th></tr></thead><tbody>
    ${items.map((it) => {
      const e = editOf(it.removable) || editOf(it.path) || state.edits.find((x) => x.path.startsWith(it.path + "."));
      const key = `L2|${it.path}|${JSON.stringify(it.value)}|${it.ptype || ""}`;
      const removed = it.removable && editOf(it.removable);
      const row = `<tr class="${e ? "edited" : ""}"><td>${tickBox(key)}</td><td>${esc(it.group)}</td><td>${esc(it.name)}${removed ? "<br><b>（已移除，不使用）</b>" : ""}</td>
        <td class="num">${esc(fmtNum(it.value))} <span class="note">${esc(it.unit)}</span>${e && !removed ? `<br><span class="ai-old">AI：${esc(fmtNum(e.ai?.value ?? e.ai))}</span>` : ""}</td>
        <td class="src">${esc(srcText(it.src))}</td><td>${editBtn(it.path)}</td></tr>`;
      return row + (state.editing === it.path ? editorL2(it) : "");
    }).join("")}</tbody></table></div>`);
  const uf = unfilledItems();
  if (uf.length) blocks.push(`<details class="pad" ${uf.some((x) => x.path === state.editing) ? "open" : ""}><summary>AI 未填的損益表欄位（${uf.length} 項，不必打勾；原文其實有這一列才需要補填）</summary>
    <div class="tablewrap"><table><thead><tr><th>項目</th><th>AI 的說明</th><th></th></tr></thead><tbody>
    ${uf.map((it) => `<tr><td>${esc(it.name)}</td><td class="note">${it.reason === "not_applicable" ? "不適用" : "未揭露"}</td><td>${editBtn(it.path)}</td></tr>${state.editing === it.path ? editorL2(it) : ""}`).join("")}
    </tbody></table></div></details>`);

  // 第三層
  const l3 = layer3Items();
  state.l3 = l3;
  blocks.push(`<h3>第三層｜不通過、需確認、PN 計算、AI 疑慮、A／B 差異（${l3.length} 項）</h3>
    <p class="pad note">每一項選一個結果。<b>數據正確</b>：原文就是如此。<b>我已改正</b>：錯誤範圍明確（一兩個數字、單位或欄位），自己在第一或第二層按「修改」改好；「不通過」改對之後會自動消失。<b>交給 AI 修正</b>：工具改不了或找不出錯在哪（漏抽、整欄抓錯期間、很多項同時不通過），寫下要求，會原文送給 AI。A／B 不同時，B 對可以按「把 A 改成 B 的值」。</p>
    <div class="tablewrap pad t3"><table><thead><tr><th style="width:90px">狀態</th><th>項目與處理方式</th></tr></thead><tbody>
    ${l3.map((it) => {
      const ch = state.choices[it.id] || {};
      let body = `<div class="item ${it.kind === "fail" ? "fail" : ""}">${esc(it.text)}</div>`;
      if (it.kind === "diff" && it.adoptable) body += `<div class="row" style="margin-top:4px"><button class="ghost small" data-adopt="${esc(it.id)}">把 A 改成 B 的值（連同出處）</button></div>`;
      body += OUTCOMES.map(([v, label]) => `<label class="choice"><input type="radio" name="${esc(it.id)}" value="${v}" data-choice="${esc(it.id)}" ${ch.choice === v ? "checked" : ""}>${esc(label)}</label>`).join("");
      const oc = OUTCOMES.find((o) => o[0] === ch.choice);
      const cid = it.id.startsWith("check:") ? it.id.slice(6) : "";
      if (it.kind === "fail" && ch.choice === "ok" && OVERRIDE_EFFECT[cid]) body += `<div class="banner">確認「數據正確」後：${esc(OVERRIDE_EFFECT[cid])}。工具不會畫出與數字互相矛盾的圖。</div>`;
      if (it.kind === "fail" && ch.choice === "ok" && UNIT_RISK.test(cid)) body += `<div class="banner"><b class="fail">這是金額單位的問題，幾乎不會是「原文如此」。</b>確認前請再看一次損益表上方的單位說明（例如 in thousands）。單位錯會讓每一張圖卡的金額差 1,000 倍。</div>`;
      if (it.kind === "fail" && ch.choice === "fixed") body += `<div class="note fail">這項仍然不通過，代表還沒改對：改對之後這一項會自動消失。</div>`;
      if (ch.choice === "ai") body += `<textarea data-text="${esc(it.id)}" placeholder="${esc(oc[2])}">${esc(ch.text || "")}</textarea>`;
      const st = resolved(it) ? `<span class="resolved">已處理</span>` : ch.choice === "ai" ? `<span class="pending">待 AI 修正</span>` : `<span class="pending">未處理</span>`;
      return `<tr><td>${st}</td><td>${body}</td></tr>`;
    }).join("")}</tbody></table></div>`);

  $("manualBox").innerHTML = blocks.join("");
  bindManual();
  updateGate();
}

/** AI 填了 null 的損益表欄位：原文其實有的話可以補填（補填後變成第二層的一般項目） */
function unfilledItems() {
  const A = state.Aeff, out = [];
  for (const [k, pair] of Object.entries(A.income_statement || {})) {
    for (const p of ["current", "prior_year"]) {
      const dp = pair?.[p];
      if (dp && dp.value === null) out.push({ group: "損益表（AI 未填）", name: `${FIELD_ZH[k] || k}｜${PERIOD_ZH[p]}`, path: `income_statement.${k}.${p}`, kind: "datapoint", value: null, ptype: "quarter", unit: A.meta.monetary_unit, src: null, reason: dp.null_reason });
    }
  }
  return out;
}

function editorL1(f, name, type, v) {
  const input = Array.isArray(type)
    ? `<select id="edVal">${type.map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>`
    : `<input type="text" id="edVal" value="${esc(v)}">`;
  const hint = f === "period_end" ? "改期末日時，工具會檢查數字出處的欄名是不是同一期；不是同一期代表 AI 抓錯整欄，只能請 AI 重新抽取。"
    : f === "fiscal_period" ? "格式：FY年份Q季，例如 FY2026Q3（用公司自己的財年）。"
    : f === "monetary_unit" || f === "share_unit" ? "改單位會同時改變每一個金額（或股數）的換算，影響所有圖卡。只有在確認原文表頭的單位說明與 AI 填的不同時才改；改完看「圖卡上營收顯示為」是否合理，自動檢查也會用 EPS、內文營收、財測三個獨立數字交叉驗證。" : "";
  return `<tr class="editor"><td></td><td colspan="3">
    <div>修改「${esc(name)}」：${input}</div>${hint ? `<div class="note">${esc(hint)}</div>` : ""}
    <input type="text" id="edNote" placeholder="備註（選填）：例如原文第 8 頁表頭寫 in millions">
    <div class="row"><button class="small" id="edSave">儲存</button><button class="ghost small" id="edCancel">取消</button>
    ${state.edits.find((e) => e.path === `meta.${f}`) ? `<button class="ghost small" id="edRevert">還原為 AI 的值</button>` : ""}<span id="edMsg" class="note"></span></div>
  </td></tr>`;
}

function editorL2(it) {
  if (it.kind === "unitfield") return `<tr class="editor"><td></td><td colspan="5">
    <div>修改「財測金額單位」：<select id="edVal">${["ones", "thousands", "millions", "billions"].map((u) => `<option ${u === it.value ? "selected" : ""}>${u}</option>`).join("")}</select></div>
    <input type="text" id="edNote" placeholder="備註（選填）：例如財測表格上方寫 in millions">
    <div class="row"><button class="small" id="edSave">儲存</button><button class="ghost small" id="edCancel">取消</button>
    ${editOf(it.path) ? `<button class="ghost small" id="edRevert">還原為 AI 的值</button>` : ""}<span id="edMsg" class="note"></span></div></td></tr>`;
  const isG = it.kind === "guidance";
  const colLabel = it.src ? (it.src.column_label || it.src.quote || "") : "";
  return `<tr class="editor"><td></td><td colspan="5">
    <div>修改「${esc(it.group)}｜${esc(it.name)}」</div>
    <label class="block">原文數值（照抄原文單位；括號或負號表示負數${isG ? "；區間寫成 13300–13600" : ""}）</label>
    <input type="text" id="edVal" value="${esc(it.value === null || it.value === undefined ? "" : it.value)}">
    ${!isG ? `<label class="block">期間類型</label><select id="edPtype">${["quarter", "ytd", "point_in_time"].map((p) => `<option value="${p}" ${p === it.ptype ? "selected" : ""}>${PTYPE_ZH[p]}</option>`).join("")}</select>
    <label class="block">出處欄名（數字所在那一欄的欄名；改抓別欄時一併修改）</label><input type="text" id="edCol" value="${esc(colLabel)}">` : ""}
    <input type="text" id="edNote" placeholder="備註（選填）：例如原文第 10 頁 Three Months Ended 欄">
    <div class="row"><button class="small" id="edSave">儲存</button><button class="ghost small" id="edCancel">取消</button>
      ${!isG ? `<button class="ghost small" id="edClear">原文沒有這個數字（清空）</button>` : ""}
      ${it.removable ? `<button class="ghost small" id="edRemove">這不是新授權（移除這一項）</button>` : ""}
      ${editOf(it.path) || editOf(it.removable) || state.edits.some((x) => x.path.startsWith(it.path + ".")) ? `<button class="ghost small" id="edRevert">還原為 AI 的值</button>` : ""}
      <span id="edMsg" class="note"></span></div>
  </td></tr>`;
}

/** "(1,234.5)"、"−1,234"、"1234" → 數字 */
function parseNum(s) {
  let t = String(s).trim().replace(/[,\s$]/g, "").replace(/[−–—]/g, "-");
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t === "" || isNaN(Number(t))) return null;
  return neg ? -Number(t) : Number(t);
}

function putEdit(e) {
  state.edits = state.edits.filter((x) => x.path !== e.path);
  state.edits.push({ ...e, at: new Date().toISOString() });
}

function bindManual() {
  const box = $("manualBox");
  box.querySelectorAll(".mc").forEach((el) => el.addEventListener("change", () => {
    el.checked ? state.ticks.add(el.dataset.key) : state.ticks.delete(el.dataset.key);
    updateGate();
  }));
  box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { state.editing = state.editing === b.dataset.edit ? null : b.dataset.edit; buildManual(); }));
  box.querySelectorAll("[data-choice]").forEach((r) => r.addEventListener("change", () => {
    const id = r.dataset.choice;
    state.choices[id] = { choice: r.value, text: state.choices[id]?.text || "" };
    recompute();
    const t = document.querySelector(`textarea[data-text="${CSS.escape(id)}"]`);
    if (t) t.focus();
  }));
  box.querySelectorAll("[data-adopt]").forEach((btn) => (btn.onclick = () => {
    const it = state.l3.find((x) => x.id === btn.dataset.adopt);
    const valOf = (n) => (n && typeof n === "object" ? n.value : n);
    const bad = it.d.paths.find((p) => {
      const a = valOf(getNode(state.A, p)), bv = valOf(getNode(state.B, p));
      return typeof a === "number" && typeof bv === "number" && a !== 0 && (Math.abs(bv / a) > 3 || Math.abs(bv / a) < 1 / 3);
    });
    if (bad || state.B.meta.monetary_unit !== state.A.meta.monetary_unit) {
      btn.insertAdjacentHTML("afterend", `<span class="note fail">　不能直接採用：B 的數字與 A 差 3 倍以上，或 B 的金額單位與 A 不同，可能單位不一致。請對照原文，到第二層手動輸入。</span>`);
      btn.disabled = true;
      return;
    }
    for (const p of it.d.paths) putEdit({ layer: 3, kind: "replace", path: p, ai: getNode(state.A, p), value: getNode(state.B, p), note: "A／B 比對：改用 B 的值" });
    recompute();
  }));
  box.querySelectorAll("[data-text]").forEach((t) => t.addEventListener("input", () => {
    const id = t.dataset.text;
    state.choices[id] = { ...(state.choices[id] || {}), text: t.value };
    updateGate();
    // 更新狀態欄
    const it = state.l3.find((x) => x.id === id);
    const cell = t.closest("tr").firstElementChild;
    cell.innerHTML = resolved(it) ? `<span class="resolved">已處理</span>` : state.choices[id].choice === "ai" ? `<span class="pending">待 AI 修正</span>` : `<span class="pending">未處理</span>`;
  }));
  // 編輯器
  const path = state.editing;
  if (!path) return;
  const msg = (t) => ($("edMsg").textContent = t);
  $("edCancel").onclick = () => { state.editing = null; buildManual(); };
  if ($("edRevert")) $("edRevert").onclick = () => {
    state.edits = state.edits.filter((e) => e.path !== path && !e.path.startsWith(path + ".") && e.path !== (layer2Items().find((x) => x.path === path)?.removable));
    state.editing = null; recompute();
  };
  const note = () => $("edNote").value.trim();

  if (path.startsWith("meta.")) {
    $("edSave").onclick = () => {
      const f = path.slice(5), v = $("edVal").value.trim();
      if (f === "period_end") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return msg("格式應為 YYYY-MM-DD");
        const chk = periodColumnCheck(state.Aeff, v);
        if (!chk.ok) {
          msg(`不能直接修改：本季數字的出處欄名是「${chk.sample}」，不是 ${v}。代表 AI 抓的是另一期的數字，已在第三層加入「交給 AI 修正」，或重新抽取。`);
          state.choices["meta:period"] = { choice: "ai", text: `本季數字應取期末日 ${v} 那一欄（目前出處欄名為「${chk.sample}」），請全部改抓正確期間的欄位。` };
          state.editing = null; buildManual();
          $("renderMsg").textContent = `期末日不能直接修改：本季數字出處是「${chk.sample}」。已在第三層加入「交給 AI 修正」。`;
          return;
        }
      }
      if (f === "fiscal_period" && !/^FY\d{4}Q[1-4]$/.test(v)) return msg("格式應為 FY2026Q3");
      const ai = getNode(state.A, path);
      if (v === String(ai)) state.edits = state.edits.filter((e) => e.path !== path);
      else putEdit({ layer: 1, kind: "field", path, ai, value: v, note: note() });
      state.editing = null; recompute();
    };
    return;
  }

  const it = layer2Items().find((x) => x.path === path) || unfilledItems().find((x) => x.path === path);
  if (it.kind === "unitfield") {
    $("edSave").onclick = () => {
      const v = $("edVal").value, ai = getNode(state.A, path);
      if (v === ai) state.edits = state.edits.filter((e) => e.path !== path);
      else putEdit({ layer: 2, kind: "field", path, ai, value: v, note: note() });
      state.editing = null; recompute();
    };
    return;
  }
  if (it.kind === "guidance") {
    $("edSave").onclick = () => {
      const raw = $("edVal").value.trim();
      const m = raw.split(/\s*[–~-]\s*(?=[\d(])/);
      const node = getNode(state.A, path);
      if (m.length === 2) {
        const lo = parseNum(m[0]), hi = parseNum(m[1]);
        if (lo === null || hi === null) return msg("區間格式不正確");
        putEdit({ layer: 2, kind: "replace", path, ai: node, value: { ...node, point: undefined, low: lo, high: hi }, note: note() });
      } else {
        const v = parseNum(raw);
        if (v === null) return msg("請輸入數字");
        putEdit({ layer: 2, kind: "replace", path, ai: node, value: { ...node, point: v, low: undefined, high: undefined }, note: note() });
      }
      state.editing = null; recompute();
    };
    return;
  }
  $("edSave").onclick = () => {
    const v = parseNum($("edVal").value);
    if (v === null) return msg("請輸入數字；原文沒有這個數字請按「清空」");
    const aiNode = getNode(state.A, path);
    const old = aiNode?.value;
    if (typeof old === "number" && old !== 0 && v !== 0) {
      const r = Math.abs(v / old);
      const warnKey = `${path}|${v}`;
      if ((r > 3 || r < 1 / 3) && state.magWarned !== warnKey) {
        state.magWarned = warnKey;
        return msg(`你輸入的數字是 AI 原值的 ${r >= 1 ? r.toFixed(r >= 100 ? 0 : 1) + " 倍" : "1/" + (1 / r).toFixed(1 / r >= 100 ? 0 : 1)}。${r > 500 || r < 1 / 500 ? "差距接近 1,000 倍，很可能用了不同單位：這一欄的單位是 " + state.Aeff.meta.monetary_unit + "，請照原文表格的數字輸入（不要自己換算）。" : "請再確認一次原文。"}確定無誤請再按一次「儲存」。`);
      }
      if (Math.sign(v) !== Math.sign(old) && state.magWarned !== warnKey + "|sign") {
        state.magWarned = warnKey + "|sign";
        return msg("正負號和 AI 原值相反。原文括號代表負數；確定無誤請再按一次「儲存」。");
      }
    }
    const col = $("edCol").value.trim(), pt = $("edPtype").value;
    const colAi = aiNode?.src ? (aiNode.src.column_label || aiNode.src.quote || "") : "";
    if (v === aiNode?.value && pt === (aiNode?.period_type || "quarter") && col === colAi) { state.edits = state.edits.filter((e) => e.path !== path); }
    else putEdit({ layer: 2, kind: "datapoint", path, ai: { value: aiNode?.value, period_type: aiNode?.period_type, column_label: colAi }, value: v, period_type: pt, column_label: col !== colAi ? col : undefined, note: note() });
    state.editing = null; recompute();
  };
  if ($("edClear")) $("edClear").onclick = () => {
    const aiNode = getNode(state.A, path);
    putEdit({ layer: 2, kind: "datapoint", path, ai: { value: aiNode?.value }, value: null, note: note() || "原文沒有這個數字" });
    state.editing = null; recompute();
  };
  if ($("edRemove")) $("edRemove").onclick = () => {
    putEdit({ layer: 2, kind: "field", path: it.removable, ai: getNode(state.A, it.removable), value: undefined, note: note() || "原文是剩餘額度，不是新授權" });
    state.editing = null; recompute();
  };
}

function pendingRequests() {
  const reqs = [];
  for (const [id, ch] of Object.entries(state.choices)) {
    if (ch.choice !== "ai") continue;
    const it = (state.l3 || []).find((x) => x.id === id);
    const path = id === "meta:period" ? "meta.period_end" : it?.path || id.replace(/^\w+:/, "");
    reqs.push({ path, issue: it ? it.text : "期末日與數字出處欄名不一致", request: ch.text || "" });
  }
  return reqs;
}

function updateGate() {
  const boxes = [...document.querySelectorAll(".mc")];
  const ticked = boxes.filter((b) => b.checked).length;
  const l3 = state.l3 || [];
  const l3done = l3.filter(resolved).length;
  const reqs = pendingRequests();
  const general = $("general").value.trim();
  const total = boxes.length + l3.length;
  const done = ticked + l3done;
  $("bar").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("progressText").textContent = `第一、二層已打勾 ${ticked} / ${boxes.length}｜第三層已處理 ${l3done} / ${l3.length}${state.edits.length ? `｜已修改 ${state.edits.length} 處` : ""}`;
  const needAI = reqs.length > 0 || general.length > 0;
  $("promptBox").hidden = !needAI;
  if (needAI) {
    const edits = state.edits.filter((e) => e.value !== undefined).map((e) => ({ path: e.path, value: e.value, period_type: e.period_type, column_label: e.column_label }));
    $("promptText").value = correctionPrompt({ requests: reqs, edits, general });
  }
  const ready = done === total && !needAI;
  $("btnRender").disabled = !ready;
  const missing = [];
  if (ticked < boxes.length) missing.push(`第一、二層還有 ${boxes.length - ticked} 項沒打勾`);
  if (l3done < l3.length) {
    const nAI = l3.filter((it) => state.choices[it.id]?.choice === "ai").length;
    const nFix = l3.filter((it) => it.kind === "fail" && state.choices[it.id]?.choice === "fixed").length;
    const nNone = l3.filter((it) => !state.choices[it.id]).length;
    if (nNone) missing.push(`第三層還有 ${nNone} 項沒選結果`);
    if (nFix) missing.push(`第三層有 ${nFix} 項選了「已改正」但仍不通過`);
    if (nAI) missing.push(`第三層有 ${nAI} 項交給 AI 修正`);
  }
  if (general) missing.push("「其他要求」有內容，需要先交給 AI");
  $("renderMsg").innerHTML = ready ? "" : `${esc(missing.join("；"))}　<button class="ghost small" id="btnNext">跳到下一個未完成項目</button>`;
  if ($("btnNext")) $("btnNext").onclick = () => {
    const box = [...document.querySelectorAll(".mc")].find((b) => !b.checked);
    const row = box ? box.closest("tr") : [...document.querySelectorAll("#manualBox .t3 tr")].find((tr) => tr.querySelector(".pending"));
    if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.style.outline = "2px solid #C2410C"; setTimeout(() => (row.style.outline = ""), 2000); }
    else $("general").scrollIntoView({ behavior: "smooth", block: "center" });
  };
}
$("general").addEventListener("input", updateGate);
$("btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("promptText").value); $("copyMsg").textContent = "已複製"; }
  catch { $("promptText").select(); $("copyMsg").textContent = "請按 Ctrl＋C 複製"; }
};

// ───── 步驟 4：圖卡
$("btnRender").onclick = async () => {
  $("s4").hidden = false;
  await drawCards();
  $("s4").scrollIntoView({ behavior: "smooth" });
};

function selectionHtml() {
  const s = state.out.selection;
  const fired = Object.entries(s.fired).map(([k, v]) => `${k}（${v.join("、")}）`).join("；") || "無";
  const skipped = Object.entries(s.skipped).map(([k, v]) => `${k}（缺 ${v.join("、")}）`).join("；") || "無";
  const unbuilt = (s.unbuilt || []).length ? `<br>觸發但圖卡尚未接上（不佔張數）：${esc(s.unbuilt.join("、"))}` : "";
  const drop = (s.dropped || []).length ? `<div class="banner">因為你在第三層確認「數據正確」而自動不畫：${esc(s.dropped.join("；"))}</div>` : "";
  const ed = state.edits.length ? `<p class="note">本次人工修改 ${state.edits.length} 處（第一層 ${state.edits.filter((e) => e.layer === 1).length}、第二層 ${state.edits.filter((e) => e.layer === 2).length}、採用 B ${state.edits.filter((e) => e.layer === 3).length}），明細寫在本季存檔。</p>` : "";
  return `<p>這次的張次：<b>${s.deck.filter((c) => state.cards.some((x) => x.id === c)).join(" → ")}</b></p>${drop}${ed}<p class="note">觸發：${esc(fired)}<br>因資料不足略過：${esc(skipped)}${unbuilt}<br>依損益表計算的數字：${esc(state.out.derived.join("；") || "無")}</p>`;
}

async function drawCards() {
  const cards = structuredClone(state.out.cards);
  const k1 = cards.find((c) => c.id === "K1");
  const nd = $("nextDate").value.trim();
  k1.body.sections = k1.body.sections.filter((s) => s.heading !== "下次財報日期");
  if (nd) k1.body.sections.push({ heading: "下次財報日期", columns: ["日期", "事件"], rows: [{ label: nd, value: "下一季財報公布（公司公告）", text: true }] });
  state.cards = cards;
  $("selBox").innerHTML = selectionHtml();
  await ensureFonts(brand, cards);
  measure = measure || createMeasurer();
  const grid = $("grid");
  grid.innerHTML = "";
  state.rendered = [];
  cards.forEach((spec, i) => {
    const r = renderCard(spec, brand, measure);
    const fname = `${state.Aeff.meta.ticker}_${spec.header.period}_${String(i + 1).padStart(2, "0")}_${spec.id}.png`;
    state.rendered.push({ svg: r.svg, fname });
    const fig = document.createElement("figure");
    fig.innerHTML = r.svg + `<figcaption><span>${i + 1}｜${spec.id}${r.fallback ? "（" + r.fallback + "）" : ""}</span><button class="ghost" data-i="${state.rendered.length - 1}">下載 PNG</button></figcaption>`;
    grid.appendChild(fig);
  });
  grid.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = async () => {
    lockExport(true);
    try { await exportOne(+b.dataset.i); }
    catch (e) { $("exportMsg").innerHTML = `<span class="fail">下載失敗：${esc(e.message)}</span>`; }
    finally { lockExport(false); }
  }));
}

async function exportOne(i) {
  const { svg, fname } = state.rendered[i];
  $("exportMsg").textContent = `正在產生 ${fname}…`;
  const { png, fontInfo } = await svgToPng(svg, { fontCssUrl: fontCss });
  download(png, fname);
  $("exportMsg").textContent = fontInfo.error
    ? `已下載 ${fname}，但字型嵌入失敗（${fontInfo.error}），圖片可能使用替代字型，請檢查。`
    : `已下載 ${fname}（嵌入 ${fontInfo.count} 個字型切片）`;
  return fontInfo;
}

// 匯出時鎖住按鈕，避免重複點擊造成重複下載或下載到改版前的圖
const lockExport = (on) => document.querySelectorAll("#s4 button").forEach((b) => (b.disabled = on));
$("btnAll").onclick = async () => {
  lockExport(true);
  try {
    for (let i = 0; i < state.rendered.length; i++) { await exportOne(i); await new Promise((r) => setTimeout(r, 400)); }
    $("exportMsg").textContent += `｜全部 ${state.rendered.length} 張完成（瀏覽器若詢問「是否允許下載多個檔案」，請選允許）`;
  } catch (e) {
    $("exportMsg").innerHTML = `<span class="fail">下載失敗：${esc(e.message)}</span>`;
  } finally { lockExport(false); }
};
$("btnApply").onclick = () => drawCards();

$("btnArchive").onclick = () => {
  const { A, Aeff, out } = state;
  const archive = {
    archive_version: "1.2",
    app_version: APP_VERSION,
    created_at: new Date().toISOString(),
    fact_sheet: Aeff,                 // 套用人工修改後、實際用來出圖的數據
    ai_fact_sheet: A,                 // AI 原始輸出
    edits: state.edits,               // 人工修改紀錄（AI 原值 → 修改值、備註）
    overrides: out.checks.filter((c) => c.status === "fail" && state.choices[`check:${c.id}`]?.choice === "ok").map((c) => c.id), // 確認「數據正確」的不通過項目
    review_choices: (state.l3 || []).map((it) => ({ item: it.text, choice: state.choices[it.id]?.choice || null, note: state.choices[it.id]?.text || "" })),
    correction_rounds: state.rounds,  // 請 AI 修正的次數
    checks: out.checks,
    derived: out.derived,
    selection: out.selection,
    second_extraction_used: !!state.B,
    diff_count: state.diffs.length,
  };
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  download(blob, `${Aeff.meta.ticker}_${Aeff.meta.fiscal_period}.json`);
  $("exportMsg").textContent = `已下載存檔。請上傳到 repo 的 history/${Aeff.meta.market}/${Aeff.meta.ticker}/ 資料夾，作為本季的核對紀錄。`;
};

window.__pnReady = true;
