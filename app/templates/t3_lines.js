// T3｜折線圖（D 獲利能力，也可用於 F 營運指標趨勢）
//
// body: {
//   unit: "%", kind: "pct",                       // 數值格式
//   periods: ["2024Q4", ..., "2026Q3"],           // 最多 8 期
//   series: [{ name: "毛利率", values: [...] }],   // 最多 6 條
//   endDelta: { kind: "pp", values: [6.3, 6.4, 6.3] }, // 選填：末端標值後面加上變動（▲ 6.4 pp）
//   兩期資料時自動改為「斜線圖」：不畫刻度，兩端直接標數值
// }

import { legend, deltaSegments } from "../lib/frame.js";
import { richLine } from "../lib/text.js";

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

export function renderT3(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, hline, fmt, cat, dot } = ctx;
  const b = spec.body;
  const f = fmt.byKind(b.kind || "pct");
  const lab = st("label");
  const small = st("small");
  let svg = "";
  let y = box.y;

  svg += text(box.x, baseline(y, small), `單位：${b.unit}`, small, { fill: c.muted });
  const unitW = measure(`單位：${b.unit}`, small) + 32;
  const lg = legend(ctx, box.x + unitW, y, box.w - unitW, b.series.map((s, i) => ({ name: s.name, color: cat(i) })));
  svg += lg.svg;
  y += lg.height + 24;

  const chartBottom = box.y + box.h;
  const axisH = lineBox(lab) + 8;
  const plotBottom = chartBottom - axisH;
  const plotTop = y + lineBox(lab) / 2;

  const all = b.series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const n = b.periods.length;
  const slope = n === 2;
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const endSegs = b.series.map((s, si) => {
    const segs = [{ str: f(s.values[s.values.length - 1]), fill: c.text, num: true }];
    const dv = b.endDelta?.values?.[si];
    if (dv !== null && dv !== undefined) segs.push({ str: "\u00A0\u00A0", fill: c.text }, ...deltaSegments(ctx, dv, b.endDelta.kind || "pp"));
    return segs;
  });
  const segW = (segs) => segs.reduce((a, x) => a + measure(x.str, lab, !!x.num), 0);
  const tickW = slope ? Math.max(...b.series.map((s) => measure(f(s.values[0]), lab, true))) : Math.max(...ticks.map((t) => measure(f(t), lab, true)));
  const endW = Math.max(...endSegs.map(segW)) + 24;
  const x0 = box.x + tickW + 16;
  const x1 = box.x + box.w - endW;
  const sy = (v) => plotBottom - ((v - t0) / (t1 - t0)) * (plotBottom - plotTop);
  const sx = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));

  // 格線與軸標（斜線圖只畫兩條時間直線）
  if (slope) {
    for (const i of [0, 1]) svg += ctx.vline(sx(i), plotTop - lineBox(lab) / 2, plotBottom, c.rule);
  } else ticks.forEach((t, i) => {
    const yy = sy(t);
    svg += hline(x0, x1, yy, i === 0 ? c.text : c.rule);
    svg += text(box.x + tickW, yy + lab.size * 0.33, f(t), lab, { fill: c.muted, anchor: "end", num: true });
  });
  b.periods.forEach((p, i) => {
    if (n > 6 && (n - 1 - i) % 2 === 1) return; // 期數多時從本季往回隔期標示
    svg += text(sx(i), baseline(plotBottom + 8, lab), p, lab, { fill: c.muted, anchor: "middle", num: true });
  });

  // 折線（資料線 2px）
  const ends = [];
  b.series.forEach((s, si) => {
    const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [sx(i), sy(v)])).filter(Boolean);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${cat(si)}" stroke-width="${ctx.brand.lines.data_width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    svg += dot(last[0], last[1], 6, cat(si));
    if (slope) svg += dot(pts[0][0], pts[0][1], 6, cat(si));
    ends.push({ y: last[1], segs: endSegs[si], y0: pts[0][1], start: f(s.values[0]) });
  });

  // 末端標值：避免重疊（最小間距一行）
  const order = ends.map((e, i) => ({ ...e, i })).sort((a, b2) => a.y - b2.y);
  const minGap = lineBox(lab);
  for (let i = 1; i < order.length; i++) {
    if (order[i].y - order[i - 1].y < minGap) order[i].y = order[i - 1].y + minGap;
  }
  order.forEach((e) => {
    svg += richLine(x1 + 16, e.y + lab.size * 0.33, e.segs, lab, {}, measure).svg;
  });
  if (slope) {
    const st0 = ends.map((e) => ({ ...e, y: e.y0 })).sort((a, b2) => a.y - b2.y);
    for (let i = 1; i < st0.length; i++) if (st0[i].y - st0[i - 1].y < minGap) st0[i].y = st0[i - 1].y + minGap;
    st0.forEach((e) => (svg += text(x0 - 16, e.y + lab.size * 0.33, e.start, lab, { fill: c.text, anchor: "end", num: true })));
  }
  return svg;
}
