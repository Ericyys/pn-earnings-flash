// 表格：表頭帶狀底；只畫上下強線與列間弱線，不畫直線（品牌規範第八節）。
// 數字欄右對齊，文字欄左對齊。

import { richLine } from "./text.js";

/**
 * cols: [{ label, align: "left"|"right", width: 相對寬度 }]
 * rows: 每列為 cell 陣列；cell 可以是字串、{ str, fill, num }，或 { segments: [...] }
 * opts: { style: "label"|"body", pad: 列上下留白 }
 * 回傳 { svg, height }
 */
export function table(ctx, x, top, w, cols, rows, opts = {}) {
  const { c, st, measure, hline, rect, baseline, lineBox, text } = ctx;
  const cell = st(opts.style || "label");
  const head = st("label");
  const pad = opts.pad ?? 12;
  const padX = 16;
  const totalW = cols.reduce((a, col) => a + (col.width || 1), 0);
  const xs = [];
  let acc = x;
  for (const col of cols) {
    const cw = (w * (col.width || 1)) / totalW;
    xs.push({ x0: acc, x1: acc + cw, align: col.align || "left" });
    acc += cw;
  }
  const anchorX = (i) => (xs[i].align === "right" ? xs[i].x1 - padX : xs[i].x0 + padX);
  const anchor = (i) => (xs[i].align === "right" ? "end" : "start");

  let svg = "";
  let y = top;
  const headH = lineBox(head) + pad * 2;
  svg += rect(x, y, w, headH, c.band);
  svg += hline(x, x + w, y, c.text);
  cols.forEach((col, i) => {
    svg += text(anchorX(i), baseline(y + pad, head), col.label, head, { fill: c.text2, anchor: anchor(i) });
  });
  y += headH;

  const rowH = lineBox(cell) + pad * 2;
  rows.forEach((row, r) => {
    if (r > 0) svg += hline(x, x + w, y, c.rule);
    const by = baseline(y + pad, cell);
    row.forEach((v, i) => {
      if (v === null || v === undefined) return;
      if (typeof v === "string") {
        svg += text(anchorX(i), by, v, cell, { fill: i === 0 ? c.text2 : c.text, anchor: anchor(i), num: i > 0 });
      } else if (v.segments) {
        svg += richLine(anchorX(i), by, v.segments, cell, { anchor: anchor(i), num: true }, measure).svg;
      } else {
        svg += text(anchorX(i), by, v.str, cell, { fill: v.fill || c.text, anchor: anchor(i), num: v.num ?? i > 0 });
      }
    });
    y += rowH;
  });
  svg += hline(x, x + w, y - 1, c.text);
  return { svg, height: y - top };
}

export const tableHeight = (ctx, nRows, opts = {}) => {
  const pad = opts.pad ?? 12;
  const cell = ctx.st(opts.style || "label");
  return ctx.lineBox(ctx.st("label")) + pad * 2 + nRows * (ctx.lineBox(cell) + pad * 2);
};
