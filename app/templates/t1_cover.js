// T1｜大數字卡（A1 數字快報封面）
//
// body: {
//   ticker: "DEMO", company: "Demo Corp", period: "2026Q3",
//   headline: "一句事實描述（由標題公式產生）",
//   kpis: [ // 最多 3 個
//     { label: "營收", unit: "USD B", value: 35.08, kind: "amount",
//       delta: { value: 18.4, kind: "pct", label: "年增" }, note: "去年同期 29.63" },
//     { label: "稀釋 EPS", unit: "USD", value: 1.2, kind: "perShare", decimals: 2,      // decimals：依原文位數（1.20）
//       delta: { value: 49, kind: "pct", label: "年增", decimals: 0 }, ... }              // 採用公司公布的年增率時依原文位數
//   ]
// }

import { deltaSegments } from "../lib/frame.js";
import { richLine } from "../lib/text.js";

export function renderT1(box, ctx, spec) {
  const { c, st, measure, text, textBlock, wrap, baseline, lineBox, hline, fmt } = ctx;
  const b = spec.body;
  let svg = "";
  let y = box.top;

  // 代號（Display）
  const disp = st("display");
  svg += text(box.x, baseline(y, disp), b.ticker, disp, { fill: c.text });
  y += lineBox(disp);

  // 公司｜季度
  const h3 = st("h3");
  svg += text(box.x, baseline(y, h3), `${b.company}｜${b.period} 財報`, h3, { fill: c.text2 });
  y += lineBox(h3) + 32;

  // 一句事實描述（H2）
  const h2 = st("h2");
  const hl = wrap(b.headline, h2, box.w, measure, { balance: true }).slice(0, 3);
  svg += textBlock(box.x, y, hl, h2, { fill: c.text }).svg;

  // KPI 區塊：貼齊內容區底部
  const small = st("small");
  const kpi = st("kpi");
  const num = st("number");
  const rowH = 16 + lineBox(small) + lineBox(kpi);
  const kpis = (b.kpis || []).slice(0, 3);
  let ky = box.y + box.h - rowH * kpis.length;

  for (const k of kpis) {
    svg += hline(box.x, box.x + box.w, ky, c.rule);
    const ly = ky + 16;
    // 百分比數值本身已帶 %，標籤不再重複單位
    const label = k.unit && k.kind !== "pct" ? `${k.label}（${k.unit}）` : k.label;
    svg += text(box.x, baseline(ly, small), label, small, { fill: c.text2 });
    if (k.note) svg += text(box.x + box.w, baseline(ly, small), k.note, small, { fill: c.muted, anchor: "end", num: true });

    const vy = ly + lineBox(small);
    const vb = baseline(vy, kpi);
    // decimals：原文直接抽取的數字（例如 EPS）依原文位數顯示；沒有指定時用該類數字的固定位數
    const valueText = k.decimals !== undefined ? fmt.fixed(k.value, k.decimals) : fmt.byKind(k.kind)(k.value);
    svg += text(box.x, vb, valueText, kpi, { fill: c.text, num: true });
    if (k.delta) {
      const segs = deltaSegments(ctx, k.delta.value, k.delta.kind, k.delta.label, k.delta.decimals);
      svg += richLine(box.x + box.w, vb, segs.map((s) => ({ ...s, st: s.fill === c.muted ? small : num })), num, { anchor: "end" }, measure).svg;
    }
    ky += rowH;
  }
  return svg;
}
