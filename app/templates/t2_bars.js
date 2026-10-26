// T2｜堆疊／單一長條圖（B 營收拆解、F 營運指標）
//
// body: {
//   unit: "USD B", kind: "amount",
//   periods: ["2025Q3", ..., "2026Q3"],         // 最多 8 期，最後一期為本季
//   series: [{ name: "雲端", values: [...] }],    // 由下往上堆疊；第 7 類起併入 other
//   table: {                                       // 選填：本季拆解表
//     columns: ["業務", "營收", "佔比", "年增"],
//     rows: [{ name, value, share, yoy }]          // share 為 %，yoy 為 %
//   }
// }

import { legend } from "../lib/frame.js";
import { table, tableHeight } from "../lib/table.js";
import { deltaSegments } from "../lib/frame.js";

export function renderT2(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, hline, rect, fmt, cat } = ctx;
  const b = spec.body;
  const f = fmt.byKind(b.kind || "amount");
  const lab = st("label");
  const small = st("small");
  let svg = "";
  let y = box.y;

  // 單位與圖例
  const multi = b.series.length > 1;
  svg += text(box.x, baseline(y, small), `單位：${b.unit}`, small, { fill: c.muted });
  if (multi) {
    const items = b.series.map((s, i) => ({ name: s.name, color: cat(i) }));
    const unitW = measure(`單位：${b.unit}`, small) + 32;
    const lg = legend(ctx, box.x + unitW, y, box.w - unitW, items);
    svg += lg.svg;
    y += lg.height + 24;
  } else {
    y += lineBox(small) + 24;
  }

  // 表格高度先保留
  const rowsT = b.table ? b.table.rows : [];
  const tH = b.table ? tableHeight(ctx, rowsT.length) + 32 : 0;
  const chartBottom = box.y + box.h - tH;
  const axisH = lineBox(lab) + 8;
  const baseY = chartBottom - axisH;
  const topPad = lineBox(lab) + 4;
  const plotH = baseY - y - topPad;

  const n = b.periods.length;
  const totals = b.periods.map((_, i) => b.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const maxV = Math.max(...totals, 0) || 1;
  const k = plotH / maxV;
  const slot = box.w / n;
  const barW = Math.min(96, slot * 0.56);

  b.periods.forEach((p, i) => {
    const cx = box.x + slot * i + slot / 2;
    let cur = baseY;
    b.series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const h = v * k;
      // 段與段之間留 1px 背景色縫（最上一段除外）
      const gap = si < b.series.length - 1 ? 0 : 0;
      svg += rect(cx - barW / 2, cur - h, barW, h - (si > 0 ? 1 : 0) - gap, multi ? cat(si) : cat(0));
      cur -= h;
    });
    // 總額標值
    svg += text(cx, cur - 4 - lineBox(lab) + baseline(0, lab), f(totals[i]), lab, { fill: c.text, anchor: "middle", num: true });
    // 期間
    svg += text(cx, baseline(baseY + 8, lab), p, lab, { fill: c.muted, anchor: "middle", num: true });
  });
  svg += hline(box.x, box.x + box.w, baseY, c.text);

  // 本季拆解表
  if (b.table) {
    const cols = [
      { label: b.table.columns[0], align: "left", width: 2.2 },
      { label: b.table.columns[1], align: "right", width: 1.4 },
      { label: b.table.columns[2], align: "right", width: 1.2 },
      { label: b.table.columns[3], align: "right", width: 1.4 },
    ];
    const rows = rowsT.map((r, i) => [
      { str: r.name, fill: c.text2, num: false, dot: i },
      f(r.value),
      fmt.pct(r.share),
      { segments: deltaSegments(ctx, r.yoy, "pct") },
    ]);
    const t = table(ctx, box.x, chartBottom + 32, box.w, cols, rows);
    svg += t.svg;
    // 第一欄加上分類色圓點
    const pad = 12;
    const rowH = lineBox(lab) + pad * 2;
    const headH = lineBox(lab) + pad * 2;
    rowsT.forEach((r, i) => {
      if (!multi) return;
      const cy = chartBottom + 32 + headH + rowH * i + rowH / 2;
      svg += ctx.dot(box.x + 16 + 6 + measure(r.name, lab) + 12, cy, 6, cat(i));
    });
  }
  return svg;
}
