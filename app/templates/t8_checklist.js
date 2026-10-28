// T8｜清單卡（K1 下季財測）
//
// spec.title：卡片標題，例如「公司下季財測（2026Q4）」
// body: {
//   sections: [
//     { heading: "", columns: ["項目", "財測"],
//       rows: [{ label: "營收（USD B）", value: "13.44" }, ...] },
//     { heading: "下次財報日期", columns: ["日期", "事件"],                 // 只有公司正式公告時才有
//       rows: [{ label: "2027-01-20", value: "下一季財報公布（公司公告）", text: true }] }
//   ]
// }
// 只放公司公布的內容，不加預告或其他資訊。

import { table } from "../lib/table.js";

export function renderT8(box, ctx, spec) {
  const { c, st, text, baseline, lineBox } = ctx;
  const b = spec.body;
  const h3 = st("h3");
  let svg = "";
  let y = box.y;

  for (const sec of b.sections) {
    if (sec.heading) {
      svg += text(box.x, baseline(y, h3), sec.heading, h3, { fill: c.text });
      y += lineBox(h3) + 16;
    }
    const cols = [
      { label: sec.columns[0], align: "left", width: 1.2 },
      { label: sec.columns[1], align: sec.rows.some((r) => r.text) ? "left" : "right", width: 1.6 },
    ];
    const rows = sec.rows.map((r) => [
      { str: r.label, fill: c.text, num: true },
      { str: r.value, fill: c.text, num: !r.text },
    ]);
    const t = table(ctx, box.x, y, box.w, cols, rows, { style: "number", pad: 12 });
    svg += t.svg;
    y += t.height + 32;
  }
  return svg;
}
