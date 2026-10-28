// 所有圖卡共用的外框：頁首、標題、來源行、免責、署名。
// 底稿只負責畫中間的內容區（box），其餘一律由這裡處理，確保每張圖卡版面一致。

import { styleOf, wrap, textBlock, text, baseline, lineBox, round } from "./text.js";
import * as fmt from "./format.js";

export const hline = (x1, x2, y, color, w = 1) =>
  `<line x1="${round(x1)}" y1="${round(y) + 0.5}" x2="${round(x2)}" y2="${round(y) + 0.5}" stroke="${color}" stroke-width="${w}"/>`;
export const vline = (x, y1, y2, color, w = 1) =>
  `<line x1="${round(x) + 0.5}" y1="${round(y1)}" x2="${round(x) + 0.5}" y2="${round(y2)}" stroke="${color}" stroke-width="${w}"/>`;
export const rect = (x, y, w, h, fill) =>
  `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, w))}" height="${round(Math.max(0, h))}" fill="${fill}"/>`;
export const dot = (cx, cy, r, fill) => `<circle cx="${round(cx)}" cy="${round(cy)}" r="${r}" fill="${fill}"/>`;
/** 圖例與標籤符號：8×8 正方形、圓角 0。x＝左緣，cy＝垂直中心（與文字置中） */
export const swatch = (x, cy, fill, size = 8) => rect(x, cy - size / 2, size, size, fill);
/** 與一行文字垂直置中的符號中心：中日韓字面約佔基線上方 0.88em、下方 0.12em，中心在基線上方約 0.38em */
export const swatchCy = (baselineY, fontSize) => baselineY - fontSize * 0.38;

/** 建立給底稿使用的工具箱 */
export function makeCtx(brand, measure) {
  const c = brand.colors.light; // 只使用淺底（業主決定）
  const st = (name, o) => styleOf(brand, name, o);
  return {
    brand, c, measure, fmt, st,
    text, textBlock, wrap, baseline, lineBox, hline, vline, rect, dot, swatch, swatchCy,
    /** 分類色：第 i 類（0 起算），第 7 類起用 other */
    cat: (i) => (i < brand.chart.max_categories ? c.categorical[i] : c.other),
    /** 漲跌色 */
    dirColor: (dir) => (dir === "up" ? c.up : dir === "down" ? c.down : c.text2),
  };
}

/**
 * 組成一張圖卡
 * spec: { header:{ticker, period, label}, title, subtitle?, source, layout? }
 * body(box, ctx) → svg 字串
 */
export function card(spec, brand, measure, body) {
  const { width: W, height: H, safe: S } = brand.canvas;
  const ctx = makeCtx(brand, measure);
  const { c, st } = ctx;
  const small = st("small");
  const innerW = W - S * 2;
  let svg = "";

  // 背景
  svg += rect(0, 0, W, H, c.bg);

  // ── 頁首：左「代號 · 季度 · 圖名」，右「帳號」
  const hdr = spec.header || {};
  const kicker = [hdr.ticker, hdr.period, hdr.label || "財報快報"].filter(Boolean).join(" · ");
  svg += text(S, baseline(S, small), kicker, small, { fill: c.text2 });
  svg += text(W - S, baseline(S, small), brand.identity.handle, small, { fill: c.muted, anchor: "end" });
  const ruleY = S + lineBox(small) + 12;
  svg += hline(S, W - S, ruleY, c.text);

  // ── 頁尾：資料來源與免責合併成一段，放在弱線下方；署名在最後一行右側
  //    有資料來源時：「資料來源：…。」＋ 免責的後半段（避免「資料整理自公司公開財報」與來源重複）
  const footText = spec.source ? `${spec.source.trim()}${brand.identity.disclaimer_with_source}` : brand.identity.disclaimer;
  const sigW = measure(brand.identity.signature, small) + 32;
  const footLines = wrap(footText, small, innerW - sigW, measure);
  const footTop = H - S - footLines.length * lineBox(small);
  const footRuleY = footTop - brand.footer.disclaimer_gap_below_rule - 1;
  svg += hline(S, W - S, footRuleY, c.rule);
  svg += textBlock(S, footTop, footLines, small, { fill: c.muted }).svg;
  svg += text(W - S, baseline(footTop + (footLines.length - 1) * lineBox(small), small), brand.identity.signature, small, { fill: c.muted, anchor: "end" });
  const bottom = footRuleY - brand.footer.disclaimer_gap_above_rule;

  // ── 標題與副標（封面自己排版；圖卡 layout="chart" 不放標題，只放圖，圖從頁首線下 32px 開始）
  let top = ruleY + (spec.layout === "chart" ? 32 : 48);
  if (spec.layout !== "cover" && spec.layout !== "chart") {
    const h2 = st("h2");
    const tl = wrap(spec.title || "", h2, innerW, measure, { balance: true });
    const tb = textBlock(S, top, tl, h2, { fill: c.text });
    svg += tb.svg;
    top += tb.height;
    if (spec.subtitle) {
      const sub = st("body");
      const sl = wrap(spec.subtitle, sub, innerW, measure);
      const sb = textBlock(S, top + 12, sl, sub, { fill: c.text2 });
      svg += sb.svg;
      top += 12 + sb.height;
    }
    top += 48;
  }

  const box = { x: S, y: top, w: innerW, h: bottom - top, top: ruleY + 48 };
  const inner = body(box, ctx, spec);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<style>.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}</style>`,
    svg,
    inner,
    `</svg>`,
  ].join("");
}

/** 圖例：8×8 方塊＋名稱，水平排列，必要時換行。回傳 { svg, height } */
export function legend(ctx, x, top, maxW, items) {
  const { st, c, measure, text, baseline, lineBox } = ctx;
  const s = st("small");
  let cx = x, cy = top, svg = "";
  for (const it of items) {
    const w = 12 + 8 + measure(it.name, s);
    if (cx > x && cx + w > x + maxW) { cx = x; cy += lineBox(s); }
    const by = baseline(cy, s);
    svg += swatch(cx, swatchCy(by, s.size), it.color); // 符號 8px，與文字間距 12px（文字起點不變）
    svg += text(cx + 20, by, it.name, s, { fill: c.muted });
    cx += w + 24;
  }
  return { svg, height: cy - top + lineBox(s) };
}

/**
 * 漲跌字串：箭頭用漲跌色，數字用主文字色。decimals 省略時為 1 位。
 * value 為 { label }（年增率的「轉正」「轉負」「N/M」）時：中性灰色、不加 ▲▼。
 * 後綴（例如「年增」）標 suffix: true，底稿可用較小字級。
 */
export function deltaSegments(ctx, value, kind, suffix = "", decimals) {
  const segs = [];
  if (value && typeof value === "object" && value.label) {
    segs.push({ str: value.label, fill: ctx.c.muted, num: true });
    if (suffix) segs.push({ str: "\u00A0" + suffix, fill: ctx.c.muted, suffix: true });
    return segs;
  }
  const d = ctx.fmt.delta(value, kind, decimals);
  // 用不換行空格（U+00A0）：SVG 會吃掉一般空格
  if (d.arrow) segs.push({ str: d.arrow + "\u00A0", fill: ctx.dirColor(d.dir) });
  segs.push({ str: d.text, fill: ctx.c.text, num: true });
  if (suffix) segs.push({ str: "\u00A0" + suffix, fill: ctx.c.muted, suffix: true });
  return segs;
}
