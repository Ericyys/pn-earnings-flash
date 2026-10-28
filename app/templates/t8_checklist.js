// T8｜清單卡（K1 下季財測／財測調整）
//
// spec.title：卡片標題，例如「公司下季財測（2026Q4）」「公司財測調整（FY2026）」
// body: {
//   sections: [
//     { heading: "", columns: ["項目", "財測"],
//       rows: [{ label: "營收（USD B）", value: "13.44" }, ...] },
//     { heading: "財測調整（FY2026）", columns: ["項目", "前次財測（7/17）", "本次財測"],
//       rows: [{ cells: ["自由現金流（USD B）", "12.5", { arrow: "down", value: "12.0" }] }] },   // arrow：up／down／flat
//     { heading: "下次財報日期", columns: ["日期", "事件"],                                   // 只有公司正式公告時才有
//       rows: [{ label: "2027-01-20", value: "下一季財報公布（公司公告）", text: true }] }
//   ]
// }
// 只放公司公布的內容，不加預告或其他資訊。財測調整的 ▲▼ 只表示數字方向（上修／下修），用漲跌色。
//
// 欄寬
// - 數字欄寬固定（三欄表每欄 NUM_W，數字比欄寬長時才加寬到放得下），靠右對齊；不會因為項目名稱長而被擠壓。
// - 項目欄寬＝剩下的寬度，固定不變；名稱超過欄寬時自動換行（「（USD B）」這類單位不拆開）。

import { table } from "../lib/table.js";

const WIDTHS_2 = [1.2, 1.6];
const NUM_W = 280;     // 三欄表的數字欄寬（px）
const PAD_X = 16;      // 與 lib/table.js 的左右內距相同

export function renderT8(box, ctx, spec) {
  const { c, st, text, baseline, lineBox, fmt, dirColor, measure, wrap } = ctx;
  const b = spec.body;
  const h3 = st("h3");
  const cellSt = st("number"), headSt = st("label");
  let svg = "";
  let y = box.y;

  const cellOf = (v) => {
    if (v && typeof v === "object" && "arrow" in v) {
      const arrow = v.arrow === "up" ? fmt.UP : v.arrow === "down" ? fmt.DOWN : "";
      return { segments: [...(arrow ? [{ str: arrow + " ", fill: dirColor(v.arrow) }] : []), { str: v.value, fill: c.text, num: true }] };
    }
    return { str: String(v), fill: c.text, num: true };
  };
  const widthOf = (cell) => (cell.segments ? cell.segments.reduce((a, x) => a + measure(x.str, cellSt, !!x.num), 0) : measure(cell.str, cellSt, cell.num));

  /** 項目名稱依欄寬斷行；結尾的「（單位）」整段保留，放不下時移到下一行 */
  const labelLines = (label, maxW) => {
    const fits = (s) => measure(s, cellSt, true) <= maxW;
    if (fits(label)) return [label];
    const m = /^(.*?)(（[^（）]*）)$/.exec(label);
    if (!m) return wrap(label, cellSt, maxW, measure);
    const lines = wrap(m[1], cellSt, maxW, measure);
    const last = lines[lines.length - 1] + m[2];
    if (fits(last)) lines[lines.length - 1] = last; else lines.push(m[2]);
    return lines;
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

    // 欄寬（px）：兩欄沿用固定比例；三欄以上數字欄固定 NUM_W（內容更長時才加寬），其餘給項目欄
    let widths;
    if (n === 2) {
      const total = WIDTHS_2.reduce((a, x) => a + x, 0);
      widths = WIDTHS_2.map((x) => (box.w * x) / total);
    } else {
      const num = sec.columns.slice(1).map((h, k) => Math.max(NUM_W, measure(h, headSt) + PAD_X * 2, ...rows.map((r) => widthOf(r[k + 1]) + PAD_X * 2)));
      widths = [box.w - num.reduce((a, x) => a + x, 0), ...num];
    }
    // 項目欄（第一欄）超過欄寬時換行；日期表等文字表不需要
    if (!textCol) for (const r of rows) {
      const cell = r[0];
      if (cell && cell.str !== undefined) {
        const lines = labelLines(cell.str, widths[0] - PAD_X * 2);
        if (lines.length > 1) r[0] = { lines, fill: cell.fill, num: cell.num };
      }
    }
    const cols = sec.columns.map((label, i) => ({ label, align: i === 0 || textCol ? "left" : "right", width: widths[i] }));
    const t = table(ctx, box.x, y, box.w, cols, rows, { style: "number", pad: 12 });
    svg += t.svg;
    y += t.height + 32;
  }
  return svg;
}
