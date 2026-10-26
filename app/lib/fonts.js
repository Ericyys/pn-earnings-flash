// 字型載入：量測文字寬度之前，必須確認圖卡上會用到的每個字都已載入。
// Google Fonts 的中文字型依字元分批下載，所以要把實際文字交給 document.fonts.load。

import { styleOf, cssFont } from "./text.js";

export async function ensureFonts(brand, specs) {
  const sample = JSON.stringify(specs) + brand.identity.disclaimer + brand.identity.signature + brand.identity.handle
    + "0123456789.,%−▲▼–（）｜：· 單位資料來源財測上緣下緣市場預期實際小計支出增加減少";
  const chars = [...new Set([...sample])].join("");
  const loads = Object.keys(brand.type).map((name) => document.fonts.load(cssFont(styleOf(brand, name)), chars));
  await Promise.all(loads);
  await document.fonts.ready;
}

/** 本機預覽用：沒有網路時，把品牌字族對應到系統已安裝的 Noto CJK 與 Inter */
export function installLocalAliases() {
  const css = `
  @font-face { font-family: "Noto Serif TC"; font-weight: 300; src: local("Noto Serif CJK TC Light"); }
  @font-face { font-family: "Noto Serif TC"; font-weight: 400; src: local("Noto Serif CJK TC"); }
  @font-face { font-family: "Noto Sans TC"; font-weight: 400; src: local("Noto Sans CJK TC"); }
  @font-face { font-family: "Inter"; font-weight: 300; src: local("Inter Light"); }
  @font-face { font-family: "Inter"; font-weight: 400; src: local("Inter Regular"); }`;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
