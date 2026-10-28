// 文字量測、斷行與 SVG 文字元素。
// 量測使用瀏覽器 canvas，所以必須在字型載入完成後才呼叫（見 lib/fonts.js 的 ensureFonts）。

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 取得字級設定，並把 family 代號換成實際字族 */
export function styleOf(brand, name, overrides = {}) {
  const t = { ...brand.type[name], ...overrides };
  return { ...t, fontFamily: brand.fonts[t.family] };
}

export function cssFont(st) {
  return `${st.weight} ${st.size}px ${st.fontFamily}`;
}

export function createMeasurer() {
  // 用隱藏的 SVG 文字元素量測：與實際輸出同一個排版引擎，等寬數字與字距都算得準
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("style", "position:absolute;left:-9999px;top:0;visibility:hidden");
  const style = document.createElementNS(NS, "style");
  style.textContent = '.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}';
  const el = document.createElementNS(NS, "text");
  svg.appendChild(style);
  svg.appendChild(el);
  document.body.appendChild(svg);
  const cache = new Map();
  return function measure(str, st, num = false) {
    const key = `${cssFont(st)}|${st.tracking}|${num ? 1 : 0}|${str}`;
    if (cache.has(key)) return cache.get(key);
    el.setAttribute("font-family", st.fontFamily);
    el.setAttribute("font-size", st.size);
    el.setAttribute("font-weight", st.weight);
    el.setAttribute("letter-spacing", st.tracking ? (st.tracking * st.size).toFixed(2) : "0");
    if (num) el.setAttribute("class", "num"); else el.removeAttribute("class");
    el.textContent = str;
    const w = str ? el.getComputedTextLength() : 0;
    cache.set(key, w);
    return w;
  };
}

// 不可出現在行首的符號、不可出現在行尾的符號
const NO_START = new Set([..."，。、；：？！）》」』〉】%％…·,.;:!?)]"]);
const NO_END = new Set([..."（《「『〈【([$"]);

/** 把文字切成斷行單位：英數詞（含數字、小數點、百分比、▲▼−）不拆；中文逐字 */
function tokenize(text) {
  const re = /[A-Za-z0-9][A-Za-z0-9.,%'’&\-–\/]*|[▲▼−+$][0-9][0-9.,%]*|\s+|./gsu;
  const raw = text.match(re) || [];
  const out = [];
  for (const tok of raw) {
    if (out.length && NO_START.has(tok[0])) { out[out.length - 1] += tok; continue; }
    if (out.length && NO_END.has(out[out.length - 1].slice(-1))) { out[out.length - 1] += tok; continue; }
    out.push(tok);
  }
  return out;
}

/** 依寬度斷行，回傳字串陣列。opts.balance＝true 時（標題用），兩行標題優先在「，」等標點後斷行，並讓兩行長度接近 */
export function wrap(text, st, maxWidth, measure, opts = {}) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    const toks = tokenize(para);
    let line = "";
    const paraLines = [];
    for (const tok of toks) {
      const trial = line + tok;
      if (line && measure(trial.trimEnd(), st) > maxWidth) {
        paraLines.push(line.trimEnd());
        line = tok.trimStart();
      } else {
        line = trial;
      }
    }
    paraLines.push(line.trimEnd());
    if (opts.balance && paraLines.length === 2) {
      const best = balanceTwo(toks, st, maxWidth, measure);
      if (best) { lines.push(...best); continue; }
    }
    lines.push(...paraLines);
  }
  return lines;
}

const SOFT_BREAK = /[，、；：。,;:]$/; // 只在標點後斷；不在「年增 18.4%」這類詞與數字之間的空格斷
function balanceTwo(toks, st, maxWidth, measure) {
  let best = null;
  for (let i = 1; i < toks.length; i++) {
    const a = toks.slice(0, i).join("").trimEnd();
    const b = toks.slice(i).join("").trim();
    if (!a || !b) continue;
    const wa = measure(a, st), wb = measure(b, st);
    if (wa > maxWidth || wb > maxWidth) continue;
    const soft = SOFT_BREAK.test(toks.slice(0, i).join(""));
    const score = (soft ? 0 : 10000) + Math.abs(wa - wb);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best ? best.lines : null;
}

/** 行高（px） */
export const lineBox = (st) => st.size * st.lineHeight;

/** 給定行框頂端，回傳基線 y。中日韓字型 ascent 約 0.88em。 */
export function baseline(top, st) {
  return top + (lineBox(st) - st.size) / 2 + st.size * 0.88;
}

/**
 * SVG 文字元素
 * opts: fill, anchor(start|middle|end), num(true＝等寬數字), opacity
 */
export function text(x, y, str, st, opts = {}) {
  const attrs = [
    `x="${round(x)}"`, `y="${round(y)}"`,
    `font-family='${st.fontFamily}'`,
    `font-size="${st.size}"`, `font-weight="${st.weight}"`,
    `fill="${opts.fill}"`,
  ];
  if (opts.anchor && opts.anchor !== "start") attrs.push(`text-anchor="${opts.anchor}"`);
  if (st.tracking) attrs.push(`letter-spacing="${(st.tracking * st.size).toFixed(2)}"`);
  if (opts.num) attrs.push(`class="num"`);
  return `<text ${attrs.join(" ")}>${esc(str)}</text>`;
}

/** 多行文字，回傳 { svg, height } */
export function textBlock(x, top, lines, st, opts = {}) {
  let svg = "";
  lines.forEach((ln, i) => {
    svg += text(x, baseline(top + i * lineBox(st), st), ln, st, opts);
  });
  return { svg, height: lines.length * lineBox(st) };
}

/** 一行中含多段不同顏色的文字（例如「▲」著色、數字用主文字色）。segments: [{str, fill, st?}] */
export function richLine(x, y, segments, st, opts = {}, measure) {
  // anchor=end 時由右往左排
  const widths = segments.map((s) => measure(s.str, s.st || st, s.num ?? opts.num ?? false));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = opts.anchor === "end" ? x - total : opts.anchor === "middle" ? x - total / 2 : x;
  let svg = "";
  segments.forEach((s, i) => {
    svg += text(cx, y, s.str, s.st || st, { fill: s.fill, num: s.num ?? opts.num });
    cx += widths[i];
  });
  return { svg, width: total };
}

export const round = (v) => Math.round(v * 100) / 100;
