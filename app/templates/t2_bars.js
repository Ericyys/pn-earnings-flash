// T2｜堆疊／單一長條圖（B 營收拆解、F 營運指標）
//
// body: {
//   unit: "USD B", kind: "amount",
//   periods: ["2025Q3", ..., "2026Q3"],         // 最多 8 期，最後一期為本季
//   series: [{ name: "雲端", values: [...] }],    // 由下往上堆疊；第 7 類起併入 other。負值畫在 0 軸下方
//   totals: [...],                                // 選填：柱頂標示的總額（財報公布的淨額）；省略時用各段加總
//   yoy: [34.4, { label: "轉正" }, ...],           // 選填：各系列本季年增率 → 最後一根長條右側標示「名稱｜金額｜▲ 年增」
// }                                               //       { label } 為轉正／轉負／N/M，用中性灰色、不加 ▲▼
// 調節項目（列在部門小計之外、但計入總營收）不傳進 series：由 compute.js 放到頁尾註腳。

import { legend, deltaSegments } from "../lib/frame.js";
import { richLine } from "../lib/text.js";

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

  const chartBottom = box.y + box.h;
  const axisH = lineBox(lab) + 8;
  const bottomY = chartBottom - axisH;   // 繪圖區底部（期間標籤在下方）
  const topPad = lineBox(lab) + 4;
  const plotH = bottomY - y - topPad;

  const n = b.periods.length;
  // 正值由 0 軸往上堆、負值由 0 軸往下堆；柱頂總額用財報公布的淨額（totals），沒給時用各段加總
  const posSum = (i) => b.series.reduce((a, s) => a + Math.max(s.values[i] || 0, 0), 0);
  const negSum = (i) => b.series.reduce((a, s) => a + Math.max(-(s.values[i] || 0), 0), 0);
  const totals = b.totals || b.periods.map((_, i) => b.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const maxPos = Math.max(...b.periods.map((_, i) => posSum(i)), 0);
  const maxNeg = Math.max(...b.periods.map((_, i) => negSum(i)), 0);
  const k = plotH / (maxPos + maxNeg || 1);
  const baseY = bottomY - maxNeg * k;    // 0 軸；沒有負值時就是繪圖區底部
  // 各期各段的位置：{ top, h }
  const geom = b.periods.map((_, i) => {
    let up = baseY, down = baseY, upFirst = true, downFirst = true;
    return b.series.map((s, si) => {
      const v = s.values[i] || 0, h = Math.abs(v) * k;
      if (v >= 0) {
        up -= h;
        const g = { top: up, h, pos: true, first: si === 0 || upFirst };
        if (h) upFirst = false;
        return g;
      }
      const g = { top: down, h, pos: false, first: downFirst };
      down += h; if (h) downFirst = false;
      return g;
    });
  });

  // 最後一根長條右側的分段標籤（只放圖的版面用來取代表格）
  const side = multi;
  const sideLines = side ? b.series.map((s, si) => {
    const v = s.values[n - 1] || 0;
    const segs = [{ str: s.name + "\u00A0\u00A0", fill: c.text2 }, { str: f(v), fill: c.text, num: true }];
    if (b.yoy && b.yoy[si] !== null && b.yoy[si] !== undefined) {
      segs.push({ str: "\u00A0\u00A0", fill: c.text }, ...deltaSegments(ctx, b.yoy[si], "pct"));
    }
    return segs;
  }) : [];
  const sideW = side ? Math.max(...sideLines.map((segs) => segs.reduce((a, x) => a + measure(x.str, lab, !!x.num), 0))) + 24 : 0;
  const plotW = box.w - sideW;
  const slot = plotW / n;
  const barW = Math.min(side ? 160 : 96, slot * 0.56);

  b.periods.forEach((p, i) => {
    const cx = box.x + slot * i + slot / 2;
    b.series.forEach((s, si) => {
      const g = geom[i][si];
      if (!g.h) return;
      // 段與段之間留 1px 背景色縫（往上堆的縫在段的下緣、往下堆的縫在段的上緣）
      const gap = g.first ? 0 : 1;
      svg += rect(cx - barW / 2, g.pos ? g.top : g.top + gap, barW, g.h - gap, multi ? cat(si) : cat(0));
    });
    // 總額標值：放在正值柱頂上方
    const topY = baseY - posSum(i) * k;
    svg += text(cx, topY - 4 - lineBox(lab) + baseline(0, lab), f(totals[i]), lab, { fill: c.text, anchor: "middle", num: true });
    // 期間
    svg += text(cx, baseline(bottomY + 8, lab), p, lab, { fill: c.muted, anchor: "middle", num: true });
  });
  svg += hline(box.x, box.x + plotW, baseY, c.text);

  if (side) {
    // 依最後一根長條各段的中心位置排標籤，彼此避讓
    const lastX = box.x + slot * (n - 1) + slot / 2 + barW / 2 + 16;
    const items = b.series.map((s, si) => {
      const g = geom[n - 1][si];
      return { si, y: g.top + g.h / 2 - lineBox(lab) / 2 };
    });
    // 由上往下排（最上面的段是最後一個系列）
    items.sort((a2, b2) => a2.y - b2.y);
    for (let i = 1; i < items.length; i++) if (items[i].y < items[i - 1].y + lineBox(lab) + 4) items[i].y = items[i - 1].y + lineBox(lab) + 4;
    const over = items[items.length - 1].y + lineBox(lab) - bottomY;
    if (over > 0) items.forEach((it) => (it.y -= over));
    for (const it of items) {
      const by = baseline(it.y, lab);
      svg += ctx.swatch(lastX, ctx.swatchCy(by, lab.size), cat(it.si));
      svg += richLine(lastX + 20, by, sideLines[it.si], lab, {}, measure).svg;
    }
  }
  return svg;
}
