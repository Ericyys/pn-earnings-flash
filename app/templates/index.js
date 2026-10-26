// 底稿入口：renderCard(spec, brand, measure) → SVG 字串
// spec.template 決定用哪一種底稿；外框（頁首、標題、來源、免責、署名）一律由 lib/frame.js 處理。

import { card } from "../lib/frame.js";
import { renderT1 } from "./t1_cover.js";
import { renderT2 } from "./t2_bars.js";
import { renderT3 } from "./t3_lines.js";
import { renderT4 } from "./t4_sankey.js";
import { renderT5, incomeWaterfall } from "./t5_waterfall.js";
import { renderT6 } from "./t6_range.js";
import { renderT7 } from "./t7_hbar.js";
import { renderT8 } from "./t8_checklist.js";

export const TEMPLATES = {
  T1: { name: "大數字卡", render: renderT1, layout: "cover" },
  T2: { name: "堆疊／單一長條圖", render: renderT2 },
  T3: { name: "折線圖", render: renderT3 },
  T4: { name: "損益流向圖", render: renderT4 },
  T5: { name: "瀑布圖", render: renderT5 },
  T6: { name: "區間圖", render: renderT6 },
  T7: { name: "橫條圖", render: renderT7 },
  T8: { name: "清單卡", render: renderT8 },
};

export function renderCard(spec, brand, measure) {
  let s = { ...spec };
  const tpl = TEMPLATES[s.template];
  if (!tpl) throw new Error(`未知的底稿：${s.template}`);
  if (tpl.layout) s.layout = tpl.layout;

  // T4 無法表達虧損：改用 T5 損益瀑布，並在結果中註記
  if (s.template === "T4") {
    let fellBack = false;
    const svg = card(s, brand, measure, (box, ctx, sp) => {
      const out = renderT4(box, ctx, sp);
      if (out !== null) return out;
      fellBack = true;
      return renderT5(box, ctx, { ...sp, body: incomeWaterfall(sp.body) });
    });
    return { svg, template: fellBack ? "T5" : "T4", fallback: fellBack ? "損益出現虧損或負流量，流向圖改為瀑布圖" : null };
  }
  return { svg: card(s, brand, measure, tpl.render), template: s.template, fallback: null };
}
