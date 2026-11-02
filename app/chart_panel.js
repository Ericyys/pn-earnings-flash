// 步驟 4｜繪圖設定：通用規則先產生預設圖卡，使用者可依公司調整「怎麼畫、怎麼算」。
// 調整的結果就是公司繪圖規範（lib/chart_rules.js），下載成 chart_rules.json 上傳到 history/<市場>/<代號>/，下次自動套用。
// 這裡只改規範，不碰數據：數字一律來自核對過的數據表。

import { CALC_OPTIONS, A1_KPI_OPTIONS, D_SERIES_OPTIONS, G_ITEM_OPTIONS, CONDITIONAL_CARDS, DEFAULT_RULES, diffRules } from "./lib/chart_rules.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ORIGIN_ZH = { rules: "公司規範", company: "公司設定檔", source: "原文", dict: "科目對照表", ai: "AI 譯名", missing: "缺少中文名稱" };

/** 需要確認的科目名稱（AI 譯名或缺少中文名稱）：確認前不能下載圖卡 */
export const pendingLabels = (out) => out.chart.labels.filter((l) => l.origin === "ai" || l.origin === "missing");

/**
 * box：容器；out：analyze() 的結果（依目前規範）；rules：目前規範；source：規範來源說明；
 * onChange(newRules)：規範改變時呼叫（由頁面重算並重畫圖卡）
 */
export function renderChartPanel(box, { out, rules, source, onChange }) {
  const ch = out.chart;
  const R = structuredClone(rules);
  const changed = diffRules(R);
  const isChanged = (path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), changed) !== undefined;
  const mark = (path) => (isChanged(path) ? ` <span class="tag">已調整</span>` : "");
  const sec = (title, body, path) => `<h3>${title}${path ? mark(path) : ""}</h3><div class="pad cp">${body}</div>`;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  const chk = (attrs, on, label) => `<label class="choice"><input type="checkbox" ${attrs} ${on ? "checked" : ""}> ${esc(label)}</label>`;
  const blocks = [];

  // ── 狀態：規範來源、本季找不到的項目、繪圖檢查、待確認名稱
  const pend = pendingLabels(out);
  const failed = ch.checks.filter((c) => c.status === "fail");
  blocks.push(`<div class="pad note"><p>先用<b>通用規則</b>產生預設圖卡；這家公司需要不同的畫法或算法時，在下面調整，圖卡會立即更新。調整完按「下載繪圖規範」，上傳到 <code>${esc(source.path)}</code>，下次這家公司就會自動套用。<b>這裡只改呈現與計算方式，不改原始數字。</b></p>
    <p>目前規範：${esc(source.text)}${Object.keys(changed).length ? `；與通用預設不同的設定 ${Object.keys(changed).length} 類` : "；全部使用通用預設"}</p></div>`);
  const warn = [];
  if (pend.length) warn.push(`<b>有 ${pend.length} 個科目名稱需要確認</b>（見下方「科目中文名稱」），確認前不能下載圖卡。`);
  if (failed.length) warn.push(`<b class="fail">繪圖檢查不通過：</b>${failed.map((c) => esc(`${c.label}（${c.detail}）`)).join("；")}。請調整設定（例如調節項目），通過前不能下載圖卡。`);
  if (ch.issues.length) warn.push(`<b>規範中有本季用不到的設定，已改用預設：</b>${ch.issues.map(esc).join("；")}`);
  if (warn.length) blocks.push(`<div class="banner">${warn.join("<br>")}</div>`);

  // ── 科目中文名稱
  const labRow = (l) => {
    const need = l.origin === "ai" || l.origin === "missing";
    const val = need ? (l.origin === "ai" ? l.zh : "") : l.zh;
    return `<tr class="${need ? "edited" : ""}"><td>${esc(l.en)}</td>
      <td><input type="text" data-label="${esc(l.id)}" value="${esc(val)}" placeholder="台灣常用的財報用語"></td>
      <td class="note">${esc(ORIGIN_ZH[l.origin])}${need ? `<br><span class="pending">${l.origin === "ai" ? "需要確認" : "請填入"}</span>` : ""}</td>
      <td>${need ? `<button class="small" data-label-ok="${esc(l.id)}">確認</button>` : `<button class="ghost small" data-label-ok="${esc(l.id)}">改名</button>`}
        ${l.origin === "rules" ? `<button class="ghost small" data-label-reset="${esc(l.id)}">還原</button>` : ""}</td></tr>`;
  };
  blocks.push(sec("科目中文名稱", `<p class="note">圖卡標籤一律中文。名稱依序採用：公司規範 → 公司設定檔 → 原文本身是中文 → 科目對照表 → AI 譯名。AI 譯名要確認一次，確認後記進公司規範，下次不用再確認。</p>
    <div class="tablewrap"><table><thead><tr><th>原文</th><th>圖卡上的名稱</th><th>來源</th><th></th></tr></thead><tbody>${ch.labels.map(labRow).join("") || `<tr><td colspan="4" class="note">沒有</td></tr>`}</tbody></table></div>`, "labels"));

  // ── 整組圖卡
  const deckRow = (code) => {
    const v = R.deck.include.includes(code) ? "include" : R.deck.exclude.includes(code) ? "exclude" : "auto";
    return `<tr><td>${code}｜${esc(CONDITIONAL_CARDS[code])}</td><td class="note">${ch.fired.includes(code) ? "本季觸發" : "本季未觸發"}</td>
      <td><select data-deck="${code}">${opt("auto", "自動（依選圖規則）", v)}${opt("include", "一定要做", v)}${opt("exclude", "一定不做", v)}</select></td></tr>`;
  };
  blocks.push(sec("整組圖卡", `<p class="note">A1、C 固定產出，K1 有財測時產出。條件圖卡預設依 <code>rules/triggers.json</code> 自動判斷（最多 2 張）；「一定要做」不論是否觸發都產出，不佔自動選圖的張數。</p>
    <div class="tablewrap"><table><tbody>${Object.keys(CONDITIONAL_CARDS).map(deckRow).join("")}</tbody></table></div>`, "deck"));

  // ── 計算方式
  const calcSel = (k) => `<label class="block">${esc(CALC_OPTIONS[k].name)}${mark(`calc.${k}`)}</label>
    <select data-calc="${k}">${Object.entries(CALC_OPTIONS[k].options).map(([v, t]) => opt(v, t, R.calc[k])).join("")}</select>`;
  let cogsBox = "";
  if (R.calc.gross_profit === "custom_cogs") {
    const list = [...(ch.hasCostOfRevenue ? [{ key: "cost_of_revenue", name: "營業成本（損益表上的營業成本列）" }] : []), ...ch.opex];
    cogsBox = `<div class="note">營業成本由哪些列組成（勾選的費用列會從營業費用移到營業成本）：</div>${list.map((it) => chk(`data-cogs="${esc(it.key)}"`, R.calc.cogs_items.includes(it.key), `${it.name}${it.en && it.en !== it.name ? `（${it.en}）` : ""}`)).join("")}`;
  }
  blocks.push(sec("計算方式", `<p class="note">各公司的算法可能不同，可以從下列方式中選擇（每一種都只用核對過的原始數字）。選了非預設的算法，圖卡頁尾會註明。可選的算法寫在 <code>rules/derivations.json</code>。</p>
    ${calcSel("gross_profit")}${cogsBox}${calcSel("eps_yoy")}${calcSel("free_cash_flow")}`));

  // ── A1
  blocks.push(sec("A1 封面｜三個重點數字", [0, 1, 2].map((i) => `<select data-a1="${i}">${Object.entries(A1_KPI_OPTIONS).map(([v, t]) => opt(v, t, R.A1.kpis[i])).join("")}</select>`).join(" "), "A1"));

  // ── C
  blocks.push(sec("C 損益流向", `${chk(`data-flag="C.show_pct"`, R.C.show_pct, "每個節點標示佔營收的百分比")}
    <div class="note" style="margin-top:8px">合併費用列（勾選 2 列以上才會合併）：</div>
    ${ch.opex.map((it) => chk(`data-merge="${esc(it.key)}"`, R.C.merge.items.includes(it.key), `${it.name}`)).join("")}
    <label class="block">合併後的名稱</label><input type="text" data-text-rule="C.merge.name" value="${esc(R.C.merge.name)}">`, "C"));

  // ── B
  const dims = [["auto", "自動（畫觸發的維度）"], ...(ch.segments.length ? [["segments", "部門"]] : []), ...(ch.geographies.length ? [["geographies", "地區"]] : [])];
  const recList = (list, title) => (list.length ? `<div class="note" style="margin-top:8px">${title}：勾選＝調節項目（不畫進柱子、不列入圖例，兩期都放註腳）</div>${list.map((r) => chk(`data-rec="${esc(r.key)}"`, r.reconciling, `${r.name}${r.ruled ? "（公司規範）" : r.ai ? "（AI 標示）" : ""}`)).join("")}` : "");
  blocks.push(sec("B 營收拆解", `<label class="block">維度</label><select data-sel-rule="B.dimension">${dims.map(([v, t]) => opt(v, t, R.B.dimension)).join("")}</select>
    ${recList(ch.segments, "部門")}${recList(ch.geographies, "地區")}
    <label class="block">佔比低於幾 % 的部門併為「其他」（0＝不合併）</label><input type="text" data-num-rule="B.other_below_pct" value="${esc(R.B.other_below_pct)}" style="width:80px">
    ${chk(`data-flag="B.show_pct"`, R.B.show_pct, "標示各部門佔總營收的百分比")}
    <label class="block">佔比位置</label><select data-sel-rule="B.pct_position">${opt("inside", "柱子裡（段太矮放不下就不標）", R.B.pct_position)}${opt("side", "右側標籤", R.B.pct_position)}</select>`, "B"));

  // ── D、G、K1
  blocks.push(sec("D 利潤率｜顯示哪幾條", Object.entries(D_SERIES_OPTIONS).map(([k, t]) => chk(`data-list="D.series" value="${k}"`, R.D.series.includes(k), t)).join(""), "D"));
  blocks.push(sec("G 現金流量｜顯示哪些項目", Object.entries(G_ITEM_OPTIONS).map(([k, t]) => chk(`data-list="G.items" value="${k}"`, R.G.items.includes(k), t)).join(""), "G"));
  if (ch.guidance.length) blocks.push(sec("K1 財測｜顯示哪些項目", ch.guidance.map((it) => chk(`data-k1="${esc(it.id)}"`, !R.K1.hide.includes(it.id), `${it.kind}｜${it.en}`)).join(""), "K1"));

  blocks.push(`<div class="row pad"><button class="ghost" data-reset-all>全部恢復通用預設</button></div>`);
  box.innerHTML = blocks.join("");

  // ── 綁定：任何調整 → 更新規範 → onChange
  const set = (path, v) => { const ks = path.split("."); let o = R; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v; };
  const get = (path) => path.split(".").reduce((o, k) => o[k], R);
  const commit = () => onChange(R);
  const q = (sel, ev, fn) => box.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));
  q("[data-label-ok]", "click", (b) => {
    const id = b.dataset.labelOk;
    const v = box.querySelector(`input[data-label="${CSS.escape(id)}"]`).value.trim();
    if (!/[㐀-鿿]/.test(v)) { if (!b.nextElementSibling?.classList.contains("fail")) b.insertAdjacentHTML("afterend", ` <span class="note fail">請輸入中文名稱</span>`); return; }
    R.labels[id] = v; commit();
  });
  q("[data-label-reset]", "click", (b) => { delete R.labels[b.dataset.labelReset]; commit(); });
  q("[data-deck]", "change", (s) => {
    const c = s.dataset.deck;
    R.deck.include = R.deck.include.filter((x) => x !== c); R.deck.exclude = R.deck.exclude.filter((x) => x !== c);
    if (s.value === "include") R.deck.include.push(c);
    if (s.value === "exclude") R.deck.exclude.push(c);
    commit();
  });
  q("[data-calc]", "change", (s) => { R.calc[s.dataset.calc] = s.value; commit(); });
  q("[data-cogs]", "change", (c) => { const k = c.dataset.cogs; R.calc.cogs_items = c.checked ? [...new Set([...R.calc.cogs_items, k])] : R.calc.cogs_items.filter((x) => x !== k); commit(); });
  q("[data-a1]", "change", (s) => { R.A1.kpis[+s.dataset.a1] = s.value; commit(); });
  q("[data-flag]", "change", (c) => { set(c.dataset.flag, c.checked); commit(); });
  q("[data-merge]", "change", (c) => { const k = c.dataset.merge; R.C.merge.items = c.checked ? [...new Set([...R.C.merge.items, k])] : R.C.merge.items.filter((x) => x !== k); commit(); });
  q("[data-text-rule]", "change", (t) => { set(t.dataset.textRule, t.value.trim() || get(t.dataset.textRule)); commit(); });
  q("[data-sel-rule]", "change", (s) => { set(s.dataset.selRule, s.value); commit(); });
  q("[data-num-rule]", "change", (t) => { const v = Number(t.value); if (Number.isFinite(v) && v >= 0 && v < 100) { set(t.dataset.numRule, v); commit(); } else t.value = get(t.dataset.numRule); });
  // 調節項目：與公司設定檔／AI 標示相同時不記進規範（規範只記公司特有的判斷）
  q("[data-rec]", "change", (c) => {
    const k = c.dataset.rec, base = [...ch.segments, ...ch.geographies].find((r) => r.key === k)?.base;
    if (c.checked === base) delete R.B.reconciling[k]; else R.B.reconciling[k] = c.checked;
    commit();
  });
  q("[data-list]", "change", (c) => { const p = c.dataset.list, cur = get(p); set(p, c.checked ? [...new Set([...cur, c.value])] : cur.filter((x) => x !== c.value)); commit(); });
  q("[data-k1]", "change", (c) => { const id = c.dataset.k1; R.K1.hide = c.checked ? R.K1.hide.filter((x) => x !== id) : [...new Set([...R.K1.hide, id])]; commit(); });
  q("[data-reset-all]", "click", () => { if (confirm("確定把這家公司的繪圖規範全部恢復成通用預設？（科目名稱也會清除）")) onChange(structuredClone(DEFAULT_RULES)); });
}
