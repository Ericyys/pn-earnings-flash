// 原文小數位數。
//
// JSON.parse 會把 12.0 變成 12、1.20 變成 1.2，原文寫了幾位小數就不見了。
// 圖卡規則：原文直接抽取、未經換算的數字，顯示的位數依抽取值的位數，不在產圖階段四捨五入。
// 所以解析 JSON 時另外讀一次原始文字，記下每個數字寫了幾位小數。
//
// 位數記在 WeakMap：{ 物件 → { 欄位名稱: 小數位數 } }，不會出現在 JSON 內容裡。
//   parseWithDecimals(text)   解析並記錄（text 必須已確認是合法 JSON）
//   decOf(obj, key)           取得某個欄位的原文位數；沒有紀錄時依數值本身推算
//   setDec(obj, key, d)       修改數字時一併記錄新的位數
//   cloneWithDecimals(obj)    複製數據表並保留位數紀錄（structuredClone 不會複製 WeakMap）

const DEC = new WeakMap();

/** 文字中的小數位數："12.50" → 2、"12" → 0、"(1,234.5)" → 1 */
export function decimalsOfText(s) {
  const m = /\.(\d+)/.exec(String(s).replace(/e[+-]?\d+$/i, ""));
  return m ? m[1].length : 0;
}

/** 數值本身的小數位數（沒有原文紀錄時的備用算法；尾數的 0 已經無法得知） */
export const plainDecimals = (v) => (typeof v === "number" && Number.isFinite(v) ? decimalsOfText(String(v)) : 0);

export function decOf(obj, key) {
  const m = obj && typeof obj === "object" ? DEC.get(obj) : null;
  if (m && key in m) return m[key];
  return plainDecimals(obj?.[key]);
}

export function setDec(obj, key, d) {
  if (!obj || typeof obj !== "object") return;
  const m = DEC.get(obj) || {};
  m[key] = d;
  DEC.set(obj, m);
}

/** 依 JSON 原文解析，結果與 JSON.parse 相同，另外記錄每個數字的小數位數 */
export function parseWithDecimals(t) {
  let i = 0;
  let lastDec = 0;
  const NUM = /-?\d+(?:\.(\d+))?(?:[eE][+-]?\d+)?/y;
  const skip = () => { while (i < t.length && " \t\n\r".includes(t[i])) i++; };
  const str = () => {
    const s = i++;
    while (t[i] !== '"') i += t[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(t.slice(s, i));
  };
  const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  function val() {
    skip();
    const ch = t[i];
    if (ch === "{" || ch === "[") {
      const isArr = ch === "[";
      const o = isArr ? [] : {};
      const dec = {};
      i++; skip();
      if (t[i] === (isArr ? "]" : "}")) { i++; return o; }
      for (let n = 0; ; n++) {
        skip();
        let k = n;
        if (!isArr) { k = str(); skip(); i++; } // 冒號
        const v = val();
        if (isArr) o.push(v); else put(o, k, v);
        if (typeof v === "number") dec[k] = lastDec;
        skip();
        if (t[i] === ",") { i++; continue; }
        i++; break; // } 或 ]
      }
      if (Object.keys(dec).length) DEC.set(o, dec);
      return o;
    }
    if (ch === '"') return str();
    for (const [w, v] of [["true", true], ["false", false], ["null", null]]) if (t.startsWith(w, i)) { i += w.length; return v; }
    NUM.lastIndex = i;
    const m = NUM.exec(t);
    i = NUM.lastIndex;
    lastDec = /[eE]/.test(m[0]) ? plainDecimals(Number(m[0])) : m[1] ? m[1].length : 0;
    return Number(m[0]);
  }
  return val();
}

/** 複製並保留位數紀錄（兩邊結構相同，平行走訪） */
export function cloneWithDecimals(src) {
  const out = structuredClone(src);
  const walk = (a, b) => {
    if (!a || typeof a !== "object" || !b || typeof b !== "object") return;
    const m = DEC.get(a);
    if (m) DEC.set(b, { ...m });
    for (const k of Object.keys(a)) walk(a[k], b[k]);
  };
  walk(src, out);
  return out;
}

/** 同一項目內的數字用相同位數：取這些數字中位數最多的 */
export function itemDecimals(pairs) {
  return Math.max(0, ...pairs.filter(([o, k]) => typeof o?.[k] === "number").map(([o, k]) => decOf(o, k)));
}
