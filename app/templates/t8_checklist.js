// T8｜清單卡（K1 下一步與預告）
//
// body: {
//   sections: [
//     { heading: "公司下季財測（2026Q4）", columns: ["項目", "財測"],
//       rows: [{ label: "營收（USD B）", value: "36.50–37.50" }, ...] },
//     { heading: "下一個關注日期", columns: ["日期", "事件"],
//       rows: [{ label: "2027-01-28", value: "2026Q4 財報公布（預計）", text: true }] }
//   ],
//   teaser: { title: "完整拆解寫在路上", text: "下一篇：……" }
// }

import { table } from "../lib/table.js";

export function renderT8(box, ctx, spec) {
  const { c, st, measure, text, textBlock, wrap, baseline, lineBox, hline, dot } = ctx;
  const b = spec.body;
  const h3 = st("h3");
  let svg = "";
  let y = box.y;

  for (const sec of b.sections) {
    svg += text(box.x, baseline(y, h3), sec.heading, h3, { fill: c.text });
    y += lineBox(h3) + 16;
    const cols = [
      { label: sec.columns[0], align: "left", width: 1.2 },
      { label: sec.columns[1], align: sec.rows.some((r) => r.text) ? "left" : "right", width: 1.6 },
    ];
    const rows = sec.rows.map((r) => [
      { str: r.label, fill: c.text2, num: true },
      { str: r.value, fill: c.text, num: !r.text },
    ]);
    const t = table(ctx, box.x, y, box.w, cols, rows, { style: "number", pad: 12 });
    svg += t.svg;
    y += t.height + 32;
  }

  if (b.teaser) {
    const body = st("body");
    const small = st("small");
    const tl0 = wrap(b.teaser.text, body, box.w - 32, measure).slice(0, 2);
    const tTop = Math.max(y + 16, box.y + box.h - (lineBox(h3) + 8 + lineBox(body) * tl0.length));
    svg += dot(box.x + 8, tTop + lineBox(h3) / 2, 8, c.text);
    svg += text(box.x + 32, baseline(tTop, h3), b.teaser.title, h3, { fill: c.text });
    svg += textBlock(box.x + 32, tTop + lineBox(h3) + 8, tl0, body, { fill: c.text2 }).svg;
  }
  return svg;
}
