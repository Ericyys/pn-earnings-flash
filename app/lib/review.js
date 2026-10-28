// 人工核對的修改與判斷。
//
// 三種處理方式（規則見 rules/review_rules.md）：
//   1. 直接修改：使用者在核對畫面輸入正確值 → applyEdits() 套用到數據表副本，AI 原值保留在修改紀錄
//   2. 判斷選項：單位、算法、PN 計算的數字要不要用、A／B 採用哪一邊 → 交給 analyze() 的 decisions
//   3. 請 AI 修正：工具無法直接處理的（漏抽、整欄抓錯、期間抓錯）→ correctionPrompt() 產生修正要求
//
// 路徑格式與 diffExtractions() 相同，例如：
//   income_statement.revenue.current
//   geographies[apac].revenue.prior_year
//   guidance_next.items[revenue|Revenue].point
//   meta.monetary_unit

/** 把路徑拆成段落：每段為 { key, id }，id 是方括號內容 */
export function parsePath(path) {
  const segs = [];
  let i = 0, buf = "";
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") { if (buf) segs.push({ key: buf }); buf = ""; i++; continue; }
    if (ch === "[") {
      const j = path.indexOf("]", i);
      segs.push({ key: buf, id: path.slice(i + 1, j) });
      buf = ""; i = j + 1; continue;
    }
    buf += ch; i++;
  }
  if (buf) segs.push({ key: buf });
  return segs;
}

const matchId = (item, id, idx) =>
  item?.key === id ||
  (item?.metric !== undefined && item?.label_source !== undefined && `${item.metric}|${item.label_source}` === id) ||
  (item?.metric !== undefined && item?.value !== undefined && `${item.metric}|${item.value}` === id) ||
  String(idx) === id;

/** 取得路徑上的節點（找不到回傳 undefined） */
export function getNode(obj, path) {
  let cur = obj;
  for (const s of parsePath(path)) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[s.key];
    if (s.id !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((x, i) => matchId(x, s.id, i));
    }
  }
  return cur;
}

/** 設定路徑上的節點（父節點必須存在） */
export function setNode(obj, path, value) {
  const segs = parsePath(path);
  const last = segs.pop();
  const parent = segs.length ? getNode(obj, segs.map((s) => (s.id !== undefined ? `${s.key}[${s.id}]` : s.key)).join(".")) : obj;
  if (parent === undefined || parent === null) return false;
  if (last.id !== undefined) {
    const arr = parent[last.key];
    if (!Array.isArray(arr)) return false;
    const i = arr.findIndex((x, k) => matchId(x, last.id, k));
    if (i < 0) return false;
    arr[i] = value;
  } else parent[last.key] = value;
  return true;
}

/**
 * 套用修改，回傳新的數據表（不改動原始資料）。
 * edit: { path, kind, ai, value, period_type?, column_label?, note, layer, by }
 *   kind="field"     直接設定欄位值（基本設定、財測數值）
 *   kind="datapoint" 修改數字節點的 value（以及選填的 period_type、出處欄名）
 *   kind="replace"   整個節點換成另一份（例如採用 B 的數字，連同出處）
 */
export function applyEdits(fs, edits) {
  const out = structuredClone(fs);
  const failed = [];
  for (const e of edits) {
    let ok = true;
    if (e.kind === "field") ok = setNode(out, e.path, e.value);
    else if (e.kind === "replace") ok = setNode(out, e.path, structuredClone(e.value));
    else {
      const node = getNode(out, e.path);
      if (!node || typeof node !== "object") ok = false;
      else {
        node.value = e.value;
        if (e.period_type) node.period_type = e.period_type;
        if (e.column_label && node.src) node.src.column_label = e.column_label;
        if (e.column_label && node.src && node.src.quote && !node.src.row_label) node.src.quote = e.column_label;
      }
    }
    if (!ok) failed.push(e);
  }
  return { fs: out, failed };
}

// ───── 期間一致性：修改期末日時，檢查數字出處的欄名是否也是這一期
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dateVariants(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return [];
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const full = MONTHS[mo - 1];
  return [
    `${full} ${d}, ${y}`, `${full.slice(0, 3)} ${d}, ${y}`, `${full.slice(0, 3)}. ${d}, ${y}`, iso,
    `${y}年${mo}月${d}日`, `${y}/${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}`, `${y}.${String(mo).padStart(2, "0")}.${String(d).padStart(2, "0")}`,
  ];
}

/** 本季數字的出處欄名，有多少比例包含指定的期末日 */
export function periodColumnCheck(fs, periodEnd) {
  const labels = Object.values(fs.income_statement || {})
    .map((p) => p?.current?.src?.column_label).filter(Boolean);
  if (!labels.length) return { ok: true, checked: 0, matched: 0, sample: null };
  const vars = dateVariants(periodEnd).map((v) => v.toLowerCase().replace(/\s+/g, " "));
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/,\s*/g, ", ");
  const matched = labels.filter((l) => vars.some((v) => norm(l).includes(v))).length;
  return { ok: matched / labels.length >= 0.8, checked: labels.length, matched, sample: labels[0] };
}

// ───── 修正要求：交給同一個 AI 對話
export function correctionPrompt({ requests, edits, general }) {
  const lines = [];
  lines.push("以下是你剛才輸出的財報數據 JSON 的修正要求。請依照原本的抽取指令與規則，修正後**重新輸出完整的 JSON**（同樣格式；只輸出一個 JSON 程式碼區塊）。");
  lines.push("");
  if (requests.length) {
    lines.push("## 需要你回原文確認並修正的項目");
    requests.forEach((r, i) => {
      lines.push(`${i + 1}. 欄位：\`${r.path || "（未指定）"}\``);
      if (r.current !== undefined) lines.push(`   目前的值：${r.current}`);
      if (r.issue) lines.push(`   問題：${r.issue}`);
      if (r.request) lines.push(`   要求：${r.request}`);
    });
    lines.push("");
  }
  if (edits.length) {
    lines.push("## 已由人工對照原文確認的值（請直接採用，不要更改）");
    for (const e of edits) {
      const v = typeof e.value === "object" ? JSON.stringify(e.value) : e.value;
      lines.push(`- \`${e.path}\` ＝ ${v}${e.period_type ? `（period_type: ${e.period_type}）` : ""}${e.column_label ? `（欄名：${e.column_label}）` : ""}`);
    }
    lines.push("");
  }
  if (general && general.trim()) {
    lines.push("## 其他要求");
    lines.push(general.trim());
    lines.push("");
  }
  lines.push("規則提醒：只抄原文、不計算、不估計；每個數字附出處；不確定就寫進 ambiguities。");
  return lines.join("\n");
}
