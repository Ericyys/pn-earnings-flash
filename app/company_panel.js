// 公司規範畫面（核對步驟 3 的最後一段）：這家公司的財務算式與科目中文名稱。
//
// 各公司新聞稿的算法可能不同（EPS 的分子、毛利包含哪些成本、營收拆解的小計與調節項目、自由現金流的定義…）。
// 在這裡選這家公司的算式，自動檢查與圖卡都會改用它，讓圖卡數字與新聞稿一致；勾稽不通過時，第三層也會直接建議算式。
// 結果記在 history/<市場>/<代號>/company_rules.json，下次自動套用。要畫哪幾張圖卡由選圖規則決定，不在這裡。

import { CALC_OPTIONS, DEFAULT_RULES, diffRules } from "./lib/company_rules.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ORIGIN_ZH = { rules: "公司規範", company: "公司設定檔", source: "原文", dict: "科目對照表", ai: "AI 譯名", missing: "缺少中文名稱" };
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** 需要確認的科目名稱（AI 譯名或缺少中文名稱）：確認前不能產出圖卡 */
export const pendingLabels = (out) => out.company.labels.filter((l) => l.origin === "ai" || l.origin === "missing");

/** 把 patch 合併進規範（物件深層合併、陣列整個取代），回傳新的規範 */
export function applyPatch(rules, patch) {
  const out = structuredClone(rules);
  const merge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (isObj(v) && isObj(dst[k])) merge(dst[k], v); else dst[k] = structuredClone(v); } };
  merge(out, patch);
  return out;
}

/**
 * box：容器；out：analyze() 的結果；rules：目前的公司規範；source：{ path, text, dirty }；
 * onChange(newRules)：規範改變（頁面整份重算）；onDownload()：下載 company_rules.json，回傳提示文字
 */
export function renderCompanyPanel(box, { out, rules, source, onChange, onDownload }) {
  const info = out.company;
  const R = structuredClone(rules);
  const changed = diffRules(R);
  const tag = (on) => (on ? ` <span class="tag">公司算式</span>` : "");
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  const chk = (attrs, on, label) => `<label class="choice"><input type="checkbox" ${attrs} ${on ? "checked" : ""}> ${esc(label)}</label>`;
  const pend = pendingLabels(out);
  const blocks = [];

  blocks.push(`<h3>公司規範｜這家公司的算式與科目名稱（會記住）</h3>
    <div class="pad note"><p>各公司新聞稿的算法可能不同（例如 EPS 的分子用歸屬普通股股東淨利、毛利包含多列成本、營收表裡有小計或調節項目）。在這裡選這家公司的算式，<b>自動檢查與圖卡都會改用它</b>，圖卡數字就會與新聞稿一致；第三層的不通過若換個算式就相符，也會直接建議。只改「怎麼算」，不改原始數字；要畫哪幾張圖卡由選圖規則決定。</p>
    <p>目前：${esc(source.text)}${Object.keys(changed).length ? "；這家公司有自己的設定（標「公司算式」的項目）" : ""}</p></div>`);
  if (info.issues.length) blocks.push(`<div class="banner"><b>規範中有本季用不到的設定，已改用通用算式：</b>${info.issues.map(esc).join("；")}</div>`);

  // ── 算式
  const calcSel = (k, extra = "") => `<label class="block">${esc(CALC_OPTIONS[k].name)}${tag(R.calc[k] !== DEFAULT_RULES.calc[k])}</label>
    <select data-calc="${k}">${Object.entries(CALC_OPTIONS[k].options).map(([v, t]) => opt(v, t, R.calc[k])).join("")}</select>${extra}`;
  const commonNote = R.calc.eps_numerator === "common" || info.hasCommon ? "" : `<div class="note">本季沒有抽到「歸屬普通股股東淨利」或「特別股股利」；選這個算式需要其中一列。</div>`;
  let cogsBox = "";
  if (R.calc.gross_profit === "custom_cogs") {
    const list = [...(info.hasCostOfRevenue ? [{ key: "cost_of_revenue", name: "營業成本（損益表上的營業成本列）" }] : []), ...info.opex];
    cogsBox = `<div class="note">營業成本由哪些列組成（勾選的費用列會從營業費用移到營業成本）：</div>${list.map((it) => chk(`data-cogs="${esc(it.key)}"`, R.calc.cogs_items.includes(it.key), `${it.name}${it.en && it.en !== it.name ? `（${it.en}）` : ""}`)).join("")}`;
  }
  blocks.push(`<div class="pad cp"><p class="note">可選的算式寫在 <code>rules/derivations.json</code>；每一種都只用核對過的原始數字，選了非預設的算式，圖卡頁尾會註明。</p>
    ${calcSel("eps_numerator", commonNote)}${calcSel("gross_profit", cogsBox)}${calcSel("eps_yoy")}${calcSel("free_cash_flow")}</div>`);

  // ── 營收拆解的項目結構
  if (info.revenueItems.length) {
    const row = (r) => `<tr><td>${esc(r.dim)}</td><td>${esc(r.name)}<div class="note">${esc(r.en)}</div></td>
      <td>${chk(`data-rec="${esc(r.key)}"`, r.reconciling, "調節項目")}${r.reconciling !== r.base ? tag(true) : ""}</td>
      <td>${chk(`data-sub="${esc(r.key)}"`, r.subtotal, "小計列")}${r.subtotal ? tag(true) : ""}</td></tr>`;
    blocks.push(`<h3>營收拆解的項目</h3><div class="pad note">調節項目：列在各部門小計之外、但計入總營收（不畫進柱子，兩期都放註腳）。小計列：AI 把小計和明細一起抽進來時勾選，不計入加總、不畫。</div>
      <div class="tablewrap pad"><table><thead><tr><th>類別</th><th>項目</th><th></th><th></th></tr></thead><tbody>${info.revenueItems.map(row).join("")}</tbody></table></div>`);
  }

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
  blocks.push(`<h3>科目中文名稱${pend.length ? `（<span class="fail">${pend.length} 項要確認</span>）` : ""}</h3>
    <p class="pad note">圖卡標籤一律中文，依序採用：公司規範 → 公司設定檔 → 原文本身是中文 → 科目對照表 → AI 譯名。AI 譯名要確認一次（確認前不能產出圖卡），確認後記進公司規範。</p>
    <div class="tablewrap pad"><table><thead><tr><th>原文</th><th>圖卡上的名稱</th><th>來源</th><th></th></tr></thead><tbody>${out.company.labels.map(labRow).join("") || `<tr><td colspan="4" class="note">沒有</td></tr>`}</tbody></table></div>`);

  blocks.push(`<div class="row pad"><button class="ghost" data-dl>下載公司規範（company_rules.json）</button>
    <button class="ghost" data-reset-all>全部恢復通用算式</button><span class="note" data-msg>${source.dirty ? `公司規範已調整，記得下載並上傳到 ${esc(source.path)}，下次才會自動套用。` : ""}</span></div>`);
  box.innerHTML = blocks.join("");

  // ── 綁定
  const commit = () => onChange(R);
  const q = (sel, ev, fn) => box.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));
  q("[data-calc]", "change", (s) => { R.calc[s.dataset.calc] = s.value; commit(); });
  q("[data-cogs]", "change", (c) => { const k = c.dataset.cogs; R.calc.cogs_items = c.checked ? [...new Set([...R.calc.cogs_items, k])] : R.calc.cogs_items.filter((x) => x !== k); commit(); });
  // 調節項目：與公司設定檔／AI 標示相同時不記進規範（規範只記這家公司特有的判斷）
  q("[data-rec]", "change", (c) => {
    const k = c.dataset.rec, base = info.revenueItems.find((r) => r.key === k)?.base;
    if (c.checked === base) delete R.revenue_items.reconciling[k]; else R.revenue_items.reconciling[k] = c.checked;
    commit();
  });
  q("[data-sub]", "change", (c) => { const k = c.dataset.sub; R.revenue_items.subtotal = c.checked ? [...new Set([...R.revenue_items.subtotal, k])] : R.revenue_items.subtotal.filter((x) => x !== k); commit(); });
  q("[data-label-ok]", "click", (b) => {
    const id = b.dataset.labelOk;
    const v = box.querySelector(`input[data-label="${CSS.escape(id)}"]`).value.trim();
    if (!/[㐀-鿿]/.test(v)) { if (!b.nextElementSibling?.classList.contains("fail")) b.insertAdjacentHTML("afterend", ` <span class="note fail">請輸入中文名稱</span>`); return; }
    R.labels[id] = v; commit();
  });
  q("[data-label-reset]", "click", (b) => { delete R.labels[b.dataset.labelReset]; commit(); });
  q("[data-dl]", "click", () => { box.querySelector("[data-msg]").textContent = onDownload(); });
  q("[data-reset-all]", "click", () => { if (confirm("確定把這家公司的規範全部恢復成通用算式？（科目名稱也會清除）")) onChange(structuredClone(DEFAULT_RULES)); });
}
