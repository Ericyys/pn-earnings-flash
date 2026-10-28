// T7｜橫條圖（I 同業對比）
//
// body: {
//   metric: "營收年增率", unit: "%", kind: "pct",
//   items: [{ name: "DEMO", value: 18.4, focal: true }, { name: "PEER A", value: 12.1 }, ...],  // 最多 8 家
//   period: "2026Q3"
// }
// 本公司用主文字色（pn-text-1），同業用 pn-chart-other；依數值由大到小排序。

export function renderT7(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, rect, vline, fmt } = ctx;
  const b = spec.body;
  const f = fmt.byKind(b.kind || "amount");
  const lab = st("label");
  const small = st("small");
  let svg = "";

  svg += text(box.x, baseline(box.y, small), `${b.metric}｜單位：${b.unit}`, small, { fill: c.muted });

  const items = [...b.items].sort((a, b2) => b2.value - a.value).slice(0, 8);
  const top = box.y + lineBox(small) + 32;
  const rowH = Math.min(120, (box.y + box.h - top) / items.length);
  const barH = Math.min(48, rowH * 0.45);
  const nameW = Math.max(...items.map((i) => measure(i.name, lab))) + 24;
  const valW = Math.max(...items.map((i) => measure(f(i.value), lab, true))) + 16;
  const lo = Math.min(0, ...items.map((i) => i.value));
  const hi = Math.max(0, ...items.map((i) => i.value));
  const x0 = box.x + nameW + (lo < 0 ? valW : 0);
  const x1 = box.x + box.w - valW;
  const sx = (v) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);
  const zero = sx(0);

  items.forEach((it, i) => {
    const cy = top + rowH * i + rowH / 2;
    svg += text(box.x, cy + lab.size * 0.33, it.name, lab, { fill: it.focal ? c.text : c.text2 });
    const a = Math.min(zero, sx(it.value)), w = Math.abs(sx(it.value) - zero);
    svg += rect(a, cy - barH / 2, Math.max(w, 1), barH, it.focal ? c.text : c.other); // 本公司 pn-text-1，其他公司 pn-chart-other
    const vx = it.value >= 0 ? sx(it.value) + 8 : sx(it.value) - 8;
    svg += text(vx, cy + lab.size * 0.33, f(it.value), lab, { fill: c.text, anchor: it.value >= 0 ? "start" : "end", num: true });
  });
  svg += vline(zero, top, top + rowH * items.length, c.text);
  return svg;
}
