// T5｜瀑布圖（G 現金與資本配置、B 成長歸因、C 虧損時的替代版）
//
// body: {
//   unit: "USD B", kind: "amount",
//   steps: [
//     { label: "營業現金流", value: 12.4, type: "total" },   // total：從 0 畫到 value
//     { label: "資本支出",   value: 6.8,  type: "use" },     // use：用掉的金額（正數），柱子往下，灰色
//     { label: "自由現金流", value: 5.6,  type: "total" },
//     { label: "部門 A",     value: 1.2,  type: "delta" },   // delta：可正可負，漲藍跌橘
//     { label: "庫藏股買回", value: 4.8, type: "bar", group: "股東回饋" }  // bar：獨立長條，從 0 畫起，不與前面連動
//   ]
// }
// total 的 value 由網頁從報告值帶入；底稿只畫，不驗算（驗算在 QC 階段）。

import { wrap as wrapText } from "../lib/text.js";

export function renderT5(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, hline, rect, fmt } = ctx;
  const b = spec.body;
  const f = fmt.byKind(b.kind || "amount");
  const lab = st("label");
  const small = st("small");
  let svg = "";

  svg += text(box.x, baseline(box.y, small), `單位：${b.unit}`, small, { fill: c.muted });
  const legendItems = [];
  const types = new Set(b.steps.map((s) => s.type));
  if (types.has("total")) legendItems.push(["小計", c.text]);
  if (types.has("use") || types.has("bar")) legendItems.push(["支出", c.other]);
  if (b.steps.some((s) => s.type === "delta" && s.value > 0)) legendItems.push(["增加", c.up]);
  if (b.steps.some((s) => s.type === "delta" && s.value < 0)) legendItems.push(["減少", c.down]);
  {
    let lx = box.x + measure(`單位：${b.unit}`, small) + 32;
    for (const [name, col] of legendItems) {
      const by = baseline(box.y, small);
      svg += ctx.dot(lx + 6, by - small.size * 0.33, 6, col);
      svg += text(lx + 20, by, name, small, { fill: c.muted });
      lx += 20 + measure(name, small) + 24;
    }
  }

  // 計算每一步的起訖
  let run = 0;
  const bars = b.steps.map((s) => {
    let y0, y1, color, shown;
    if (s.type === "total") { y0 = 0; y1 = s.value; run = s.value; color = c.text; shown = f(s.value); }
    else if (s.type === "use") { y0 = run; y1 = run - s.value; run = y1; color = c.other; shown = f(-s.value); }
    else if (s.type === "bar") { y0 = 0; y1 = s.value; color = c.other; shown = f(s.value); }
    else { y0 = run; y1 = run + s.value; run = y1; color = s.value >= 0 ? c.up : c.down; shown = null; }
    return { ...s, y0, y1, color, shown };
  });
  const lo = Math.min(0, ...bars.map((x) => Math.min(x.y0, x.y1)));
  const hi = Math.max(0, ...bars.map((x) => Math.max(x.y0, x.y1)));

  const n = bars.length;
  const slot = box.w / n;
  const barW = Math.min(100, slot * 0.6);
  const catLines = bars.map((x) => wrapText(x.label, lab, slot - 8, measure).slice(0, 2));
  const axisH = Math.max(...catLines.map((l) => l.length)) * lineBox(lab) + 8;
  const hasGroup = bars.some((x) => x.type === "bar" && x.group);
  const groupTop = box.y + lineBox(small) + 32;
  const plotTop = groupTop + (hasGroup ? lineBox(lab) + 16 : 0) + lineBox(lab) + 4;
  const plotBottom = box.y + box.h - axisH - (lo < 0 ? lineBox(lab) + 4 : 0);
  const k = (plotBottom - plotTop) / (hi - lo || 1);
  const sy = (v) => plotBottom - (v - lo) * k;

  bars.forEach((x, i) => {
    const cx = box.x + slot * i + slot / 2;
    const top = sy(Math.max(x.y0, x.y1)), bot = sy(Math.min(x.y0, x.y1));
    svg += rect(cx - barW / 2, top, barW, Math.max(bot - top, 1), x.color);
    // 連接線（獨立長條不連）
    if (i < n - 1 && bars[i + 1].type !== "bar" && x.type !== "bar") {
      const ny = sy(x.y1);
      svg += hline(cx + barW / 2, cx + slot - barW / 2, ny, c.rule);
    }
    // 標值：往上的柱子標在上方，往下的柱子標在下方
    const label = x.type === "delta" ? f(x.value) : x.shown;
    const goingDown = x.type === "use" || (x.type === "delta" && x.value < 0) || (x.type === "total" && x.value < 0)
      || Math.max(x.y0, x.y1) < 0; // 整根柱子在 0 以下時，標值放下方，避免壓到 0 軸
    const ly = goingDown ? baseline(bot + 4, lab) : top - 4 - lineBox(lab) + baseline(0, lab);
    svg += text(cx, ly, label, lab, { fill: c.text, anchor: "middle", num: true });
  });
  svg += hline(box.x, box.x + box.w, sy(0), c.text);

  // 獨立長條群組：前方畫分隔線，上方寫群組名稱
  const firstBar = bars.findIndex((x) => x.type === "bar");
  if (firstBar > 0) {
    const sepX = box.x + slot * firstBar;
    svg += ctx.vline(sepX, groupTop, plotBottom, c.rule);
    const gName = bars[firstBar].group;
    if (gName) svg += text(sepX + 12, baseline(groupTop, lab), gName, lab, { fill: c.muted });
  }

  // 類別標籤
  catLines.forEach((lines, i) => {
    const cx = box.x + slot * i + slot / 2;
    lines.forEach((ln, j) => {
      svg += text(cx, baseline(box.y + box.h - axisH + 8 + j * lineBox(lab), lab), ln, lab, { fill: c.muted, anchor: "middle" });
    });
  });
  return svg;
}

/** C 卡無法畫流向圖時（虧損），改成損益瀑布 */
export function incomeWaterfall(b) {
  const hasGP = b.grossProfit !== null && b.grossProfit !== undefined && b.cogs > 0;
  const steps = [{ label: "營收", value: b.revenue, type: "total" }];
  if (b.cogs > 0) steps.push({ label: "營業成本", value: b.cogs, type: "use" });
  if (hasGP) steps.push({ label: "毛利", value: b.grossProfit, type: "total" });
  steps.push({ label: "營業費用", value: b.opex.reduce((a, o) => a + o.value, 0), type: "use" });
  if (b.otherOperating) steps.push({ label: "其他營業收支", value: b.otherOperating, type: "delta" });
  steps.push({ label: "營業利益", value: b.operatingIncome, type: "total" });
  if (b.stopAt !== "operating_income") {
    if (b.nonOperating) steps.push({ label: "業外收支", value: b.nonOperating, type: "delta" });
    if (b.tax) steps.push({ label: "所得稅", value: b.tax, type: "use" });
    steps.push({ label: "淨利", value: b.netIncome, type: "total" });
  }
  return { unit: b.unit, kind: "amount", steps };
}
