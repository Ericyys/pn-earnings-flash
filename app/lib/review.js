// 人工核對的修改與判斷。
//
// 處理方式（規則見 rules/review_rules.md）：
//   1. 直接修改：使用者在第一、二層輸入正確值，或把 A 改成 B 的值 → applyEdits() 套用到數據表副本，AI 原值保留在修改紀錄
//   2. 確認數據正確：對「不通過」選「數據正確」→ 由 analyze() 的 overrides 處理（自動少畫有矛盾的那一段）
//   3. 交給 AI 修正：工具無法直接處理的（漏抽、整欄抓錯、期間抓錯）→ correctionPrompt() 產生修正要求
//
import { cloneWithDecimals, setDec, plainDecimals } from "./decimals.js";

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
  const out = cloneWithDecimals(fs);
  const failed = [];
  for (const e of edits) {
    let ok = true;
    if (e.kind === "field") ok = setNode(out, e.path, e.value);
    else if (e.kind === "replace") {
      // 採用 B 的節點時沿用 B 的原文位數；手動輸入財測時用輸入文字的位數（e.dec）
      const v = cloneWithDecimals(e.value);
      if (e.dec && v && typeof v === "object") for (const [k, d] of Object.entries(e.dec)) setDec(v, k, d);
      ok = setNode(out, e.path, v);
    } else {
      const node = getNode(out, e.path);
      if (!node || typeof node !== "object") ok = false;
      else {
        node.value = e.value;
        setDec(node, "value", e.dec ?? plainDecimals(e.value));
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
/**
 * 給 AI 的整理：使用者的判斷＋交給 AI 的問題＋已人工確認的值＋其他要求，合成一段可直接貼上的文字。
 * userDecisions: [{ path, issue, decision }]   使用者的判斷，AI 必須照做
 * aiItems:       [{ path, issue, request }]    交給 AI 依原文重新判斷的問題
 * edits:         [{ path, value, period_type?, column_label? }]  已人工對照原文確認的值
 */
export function correctionPrompt({ userDecisions = [], aiItems = [], edits = [], general = "" }) {
  const L = [];
  L.push("以下是你剛才輸出的財報數據 JSON 的修正要求。請依照原本的抽取指令與規則逐項處理，然後**重新輸出完整的 JSON**（同樣格式，schema_version 填 \"1.4\"；只輸出一個 JSON 程式碼區塊，不要解說）。");
  L.push("");
  if (userDecisions.length) {
    L.push("## 一、人工判斷（已由人對照原文決定，請直接照做）");
    userDecisions.forEach((r, i) => {
      L.push(`${i + 1}. 欄位：\`${r.path || "（未指定）"}\``);
      L.push(`   問題：${r.issue}`);
      L.push(`   判斷：${r.decision}`);
    });
    L.push("");
  }
  if (aiItems.length) {
    L.push(`## ${userDecisions.length ? "二" : "一"}、請你回原文重新判斷並處理`);
    aiItems.forEach((r, i) => {
      L.push(`${i + 1}. 欄位：\`${r.path || "（未指定）"}\``);
      L.push(`   問題：${r.issue}`);
      L.push(`   要求：${r.request}`);
    });
    L.push("");
  }
  if (edits.length) {
    L.push("## 已由人工對照原文確認的值（請直接採用，不要更改）");
    for (const e of edits) {
      const v = typeof e.value === "object" ? JSON.stringify(e.value) : e.value;
      L.push(`- \`${e.path}\` ＝ ${v}${e.period_type ? `（period_type: ${e.period_type}）` : ""}${e.column_label ? `（欄名：${e.column_label}）` : ""}`);
    }
    L.push("");
  }
  if (general && general.trim()) {
    L.push("## 其他要求");
    L.push(general.trim());
    L.push("");
  }
  L.push("## 處理原則");
  L.push("- 只抄原文、不計算、不估計；每個數字附出處。");
  L.push("- 能從原文確定的問題：直接修正數據，並在 notes 用一句話說明怎麼處理的。");
  L.push("- 只有原文無法確定、需要人決定的，才留在 ambiguities，並寫清楚需要人決定什麼。");
  L.push("- 上面沒有提到的欄位維持原樣，不要重新抽取或改動。");
  return L.join("\n");
}
