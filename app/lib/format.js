// PN 數字格式（品牌規範第七節）。所有底稿上的數字都必須經過這裡，不得自行格式化。
//
// 規則摘要
// - 千分位加逗號。金額 2 位小數，百分比 1 位，倍數 1 位（12.3x），百分點 1 位。
// - 漲跌幅：「▲ 5.2%」，符號放數字前、空一格、不加 +／−。
// - 一般負值（虧損等）：用 U+2212「−」，不加括號，不用 ▼。
// - 單位放表頭或軸標，數字本身不帶單位。

export const MINUS = "−";
export const UP = "▲";
export const DOWN = "▼";

// 十進位四捨五入（避免 35.075.toFixed(2) 因浮點誤差變成 35.07）
export function round(v, d) {
  const sgn = v < 0 ? -1 : 1;
  return sgn * Number(Math.round(Number(Math.abs(v) + "e" + d)) + "e-" + d);
}

function grouped(abs, decimals) {
  const fixed = round(abs, decimals).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const intG = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${intG}.${frac}` : intG;
}

function signed(v, decimals) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const r = round(v, decimals);
  const body = grouped(Math.abs(r), decimals);
  return r < 0 ? `${MINUS}${body}` : body;
}

/** 一位小數、不加單位（標題句中的百分比數值用）：11.8、−3.0 */
export const fixed1 = (v) => signed(v, 1);
/** 金額：35.08、1,234.50、−0.85 */
export const amount = (v) => signed(v, 2);
/** 每股金額（EPS、股利）：與金額同為 2 位小數 */
export const perShare = (v) => signed(v, 2);
/** 百分比數值（毛利率等），輸入 58.63 → "58.6%" */
export const pct = (v) => (v === null || v === undefined ? "—" : `${signed(v, 1)}%`);
/** 倍數：12.3x */
export const multiple = (v) => (v === null || v === undefined ? "—" : `${signed(v, 1)}x`);
/** 整數計數（用戶數等），不加小數 */
export const count = (v) => signed(v, 0);

/**
 * 漲跌：回傳 { arrow, text, dir }。arrow 由底稿著色（漲藍跌橘），text 用主文字色。
 * kind: "pct"（年增率等，單位 %）或 "pp"（百分點）
 * 0 或四捨五入後為 0 → 不加箭頭，dir="flat"
 */
export function delta(v, kind = "pct") {
  if (v === null || v === undefined || Number.isNaN(v)) return { arrow: "", text: "—", dir: "na" };
  const r = round(v, 1);
  const body = grouped(Math.abs(r), 1);
  const unit = kind === "pp" ? " pp" : "%";
  if (r === 0) return { arrow: "", text: `0.0${unit}`, dir: "flat" };
  return { arrow: r > 0 ? UP : DOWN, text: `${body}${unit}`, dir: r > 0 ? "up" : "down" };
}

/** 依 kind 選格式器 */
export function byKind(kind) {
  return { amount, perShare, pct, multiple, count }[kind] || amount;
}

/** 單位標示：currency + unit，例如 "USD B"、"TWD 億"、"%"、"USD" */
export function unitLabel({ currency, unit }) {
  if (!currency && !unit) return "";
  if (!currency) return unit;
  if (!unit) return currency;
  return `${currency} ${unit}`;
}

// 簡易自我檢查（在瀏覽器 console 或 node 執行 selfTest()）
export function selfTest() {
  const cases = [
    [amount(35.075), "35.08"], [amount(1234.5), "1,234.50"], [amount(-0.851), `${MINUS}0.85`],
    [pct(58.63), "58.6%"], [pct(-3.04), `${MINUS}3.0%`], [multiple(12.34), "12.3x"],
    [delta(5.24).text, "5.2%"], [delta(5.24).arrow, UP], [delta(-3.1, "pp").text, "3.1 pp"],
    [delta(-3.1, "pp").arrow, DOWN], [delta(0.04).dir, "flat"], [count(1234567), "1,234,567"],
  ];
  const fails = cases.filter(([a, b]) => a !== b);
  return fails.length ? fails : "format ok";
}
