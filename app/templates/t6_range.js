// T6｜區間圖（E 對比預期）
//
// body: {
//   rows: [   // 最多 3 列
//     { label: "營收", unit: "USD B", kind: "amount",
//       basis: "Non-GAAP",              // 選填：會計基準
//       low: 33.5, high: 34.5,          // 公司財測區間（只給單點時 low＝high＝point）
//       consensus: 34.2,                // 市場預期（選填，必須同基準）
//       actual: 35.08 }
//   ]
// }
// 每列右上角自動寫出位置（高於財測上緣／落在財測區間內／低於財測下緣），只陳述位置，不評價。

export function positionText(r) {
  if (r.low === undefined || r.high === undefined) return "";
  if (r.actual > r.high) return "高於財測上緣";
  if (r.actual < r.low) return "低於財測下緣";
  return "落在財測區間內";
}

export function renderT6(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, hline, vline, rect, dot, fmt } = ctx;
  const rows = spec.body.rows.slice(0, 3);
  const body = st("body");
  const lab = st("label");
  const small = st("small");
  let svg = "";

  const rowH = box.h / rows.length;
  rows.forEach((r, ri) => {
    const f = fmt.byKind(r.kind || "amount");
    const y = box.y + rowH * ri;
    if (ri > 0) svg += hline(box.x, box.x + box.w, y - 24, c.rule);

    // 列標題與位置描述
    const paren = [r.basis, r.kind === "pct" ? null : r.unit].filter(Boolean).join("，");
    svg += text(box.x, baseline(y, body), paren ? `${r.label}（${paren}）` : r.label, body, { fill: c.text });
    const pt = positionText(r);
    if (pt) svg += text(box.x + box.w, baseline(y, body), pt, small, { fill: c.text2, anchor: "end" });

    // 刻度範圍：涵蓋所有點，左右各留 20%
    const vals = [r.low, r.high, r.consensus, r.actual].filter((v) => v !== undefined && v !== null);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    lo -= span * 0.25; hi += span * 0.25;
    const x0 = box.x + 24, x1 = box.x + box.w - 24;
    const sx = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);

    const labelsTop = y + lineBox(body) + 8;
    const trackY = labelsTop + lineBox(lab) * 2 + 20;
    const bandH = 24;

    // 軸線
    svg += hline(box.x, box.x + box.w, trackY, c.rule);
    // 財測區間
    if (r.low !== undefined && r.high !== undefined) {
      const a = sx(r.low), b = sx(r.high);
      svg += rect(a, trackY - bandH / 2, Math.max(b - a, 2), bandH, c.band);
      svg += vline(a, trackY - 20, trackY + 20, c.text);
      svg += vline(b, trackY - 20, trackY + 20, c.text);
      const gy = baseline(trackY + 24, lab);
      if (r.low === r.high) {
        svg += text(a, gy, `財測 ${f(r.low)}`, lab, { fill: c.muted, anchor: "middle", num: true });
      } else {
        const tl = `財測下緣 ${f(r.low)}`, th = `財測上緣 ${f(r.high)}`;
        const wl = measure(tl, lab, true), wh = measure(th, lab, true);
        let ax = a, bx = b;
        // 兩個標籤靠太近時往外推開
        const need = wl / 2 + wh / 2 + 16 - (bx - ax);
        if (need > 0) { ax -= need / 2; bx += need / 2; }
        ax = Math.max(ax, box.x + wl / 2); bx = Math.min(bx, box.x + box.w - wh / 2);
        svg += text(ax, gy, tl, lab, { fill: c.muted, anchor: "middle", num: true });
        svg += text(bx, gy, th, lab, { fill: c.muted, anchor: "middle", num: true });
      }
    }
    // 市場預期與實際值的標籤（在軌道上方，兩層）
    const place = (x, str) => {
      const w = measure(str, lab, true);
      return Math.min(Math.max(x, box.x + w / 2), box.x + box.w - w / 2);
    };
    const actStr = `實際 ${f(r.actual)}`;
    const ax = place(sx(r.actual), actStr);
    if (r.consensus !== undefined && r.consensus !== null) {
      const cStr = `市場預期 ${f(r.consensus)}`;
      const cx = sx(r.consensus);
      const cxL = place(cx, cStr);
      const overlap = Math.abs(cxL - ax) < (measure(cStr, lab, true) + measure(actStr, lab, true)) / 2 + 16;
      const cTop = overlap ? labelsTop : labelsTop + lineBox(lab);
      svg += vline(cx, trackY - 20, trackY + 20, c.muted);
      svg += text(cxL, baseline(cTop, lab), cStr, lab, { fill: c.muted, anchor: "middle", num: true });
    }
    svg += dot(sx(r.actual), trackY, 10, c.text);
    svg += text(ax, baseline(labelsTop + lineBox(lab), lab), actStr, lab, { fill: c.text, anchor: "middle", num: true });
  });
  return svg;
}
