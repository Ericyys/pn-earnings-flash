// T8｜清單卡（K1 下季財測／財測調整）
//
// spec.title：卡片標題，例如「公司下季財測（2026Q4）」「公司財測調整（FY2026）」
// body: {
//   sections: [
//     { heading: "", columns: ["項目", "財測"],
//       rows: [{ label: "營收（USD B）", value: "13.44" }, ...] },
//     { heading: "財測調整（FY2026）", columns: ["項目", "調整前", "調整後"],
//       rows: [{ cells: ["自由現金流（USD B）", "12.50", { arrow: "down", value: "12.00" }] }] },   // arrow：up／down／flat
//     { heading: "下次財報日期", columns: ["日期", "事件"],                                   // 只有公司正式公告時才有
//       rows: [{ label: "2027-01-20", value: "下一季財報公布（公司公告）", text: true }] }
//   ]
// }
// 只放公司公布的內容，不加預告或其他資訊。財測調整的 ▲▼ 只表示數字方向（上修／下修），用漲跌色。

import { table } from "../lib/table.js";

const WIDTHS_2 = [1.2, 1.6];

export function renderT8(box, ctx, spec) {
  const { c, st, text, baseline, lineBox, fmt, dirColor, measure } = ctx;
  const b = spec.body;
  const h3 = st("h3");
  let svg = "";
  let y = box.y;

  const cellOf = (v) => {
    if (v && typeof v === "object" && "arrow" in v) {
      const arrow = v.arrow === "up" ? fmt.UP : v.arrow === "down" ? fmt.DOWN : "";
      return { segments: [...(arrow ? [{ str: arrow + "\u00A0", fill: dirColor(v.arrow) }] : []), { str: v.value, fill: c.text, num: true }] };
    }
    return { str: String(v), fill: c.text, num: true };
  };

  for (const sec of b.sections) {
    if (sec.heading) {
      svg += text(box.x, baseline(y, h3), sec.heading, h3, { fill: c.text });
      y += lineBox(h3) + 16;
    }
    const n = sec.columns.length;
    const textCol = sec.rows.some((r) => r.text);
    const rows = sec.rows.map((r) => (r.cells
      ? r.cells.map(cellOf)
      : [{ str: r.label, fill: c.text, num: true }, { str: r.value, fill: c.text, num: !r.text }]));
    // 兩欄沿用固定比例；三欄以上依內容實際寬度分配，剩餘空間給第一欄，避免數字擠在一起
    let widths = WIDTHS_2;
    if (n !== 2) {
      const cellSt = st("number"), headSt = st("label");
      const wOf = (cell) => (cell.segments ? cell.segments.reduce((a, x) => a + measure(x.str, cellSt, !!x.num), 0) : measure(cell.str, cellSt, cell.num));
      const need = sec.columns.map((h, i) => Math.max(measure(h, headSt), ...rows.map((r) => wOf(r[i]))) + 32 + 16);
      const extra = Math.max(0, box.w - need.reduce((a, x) => a + x, 0));
      widths = need.map((x, i) => (i === 0 ? x + extra : x));
    }
    const cols = sec.columns.map((label, i) => ({ label, align: i === 0 || textCol ? "left" : "right", width: widths[i] }));
    const t = table(ctx, box.x, y, box.w, cols, rows, { style: "number", pad: 12 });
    svg += t.svg;
    y += t.height + 32;
  }
  return svg;
}
