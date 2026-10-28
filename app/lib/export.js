// 圖卡匯出成 PNG。
// 瀏覽器把 SVG 畫到 canvas 時不會使用網頁已載入的字型，所以要把字型直接嵌進 SVG。
// 中文字型很大，Google Fonts 依字元切成許多小檔（unicode-range），這裡只嵌入這張圖卡實際用到的那幾片。

const fontCache = new Map(); // url → data URI
let cssCache = null;

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** 圖卡上實際出現的字元碼位 */
function usedCodepoints(svg) {
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => decodeEntities(m[1])).join("");
  return new Set([...texts].map((ch) => ch.codePointAt(0)));
}

function parseRanges(s) {
  if (!s) return null;
  return s.split(",").map((part) => {
    const p = part.trim().replace(/^U\+/i, "");
    if (p.includes("-")) { const [a, b] = p.split("-"); return [parseInt(a, 16), parseInt(b, 16)]; }
    if (p.includes("?")) return [parseInt(p.replace(/\?/g, "0"), 16), parseInt(p.replace(/\?/g, "F"), 16)];
    const v = parseInt(p, 16); return [v, v];
  });
}

function parseFontFaces(css, baseUrl) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1];
    const get = (prop) => (new RegExp(`${prop}\\s*:\\s*([^;]+);?`, "i").exec(body) || [])[1]?.trim();
    const family = (get("font-family") || "").replace(/['"]/g, "");
    const urlM = /url\(\s*['"]?([^'")]+)['"]?\s*\)\s*(?:format\(\s*['"]?([^'")]+)['"]?\s*\))?/.exec(get("src") || "");
    if (!family || !urlM) continue;
    faces.push({
      family,
      weight: get("font-weight") || "400",
      style: get("font-style") || "normal",
      url: new URL(urlM[1], baseUrl).href,
      format: urlM[2] || null,
      rangeText: get("unicode-range") || null,
      ranges: parseRanges(get("unicode-range")),
    });
  }
  return faces;
}

const toDataUri = async (url) => {
  if (fontCache.has(url)) return fontCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字型下載失敗：${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const mime = res.headers.get("content-type") || "font/woff2";
  const uri = `data:${mime};base64,${btoa(bin)}`;
  fontCache.set(url, uri);
  return uri;
};

/** 產生只含必要字型切片的 @font-face 樣式 */
export async function embeddedFontCss(svg, fontCssUrl) {
  fontCssUrl = new URL(fontCssUrl, location.href).href; // 相對路徑轉成完整網址
  if (!cssCache || cssCache.url !== fontCssUrl) {
    const res = await fetch(fontCssUrl);
    if (!res.ok) throw new Error("字型樣式表下載失敗");
    cssCache = { url: fontCssUrl, faces: parseFontFaces(await res.text(), fontCssUrl) };
  }
  const cps = usedCodepoints(svg);
  const families = new Set([...svg.matchAll(/font-family='([^']+)'/g)].flatMap((m) => m[1].split(",").map((f) => f.trim().replace(/['"]/g, ""))));
  const weights = new Set([...svg.matchAll(/font-weight="(\d+)"/g)].map((m) => m[1]));
  const need = cssCache.faces.filter((f) => {
    if (!families.has(f.family)) return false;
    const fw = f.weight.split(/\s+/).map(Number);
    const wOk = [...weights].some((w) => (fw.length === 2 ? w >= fw[0] && w <= fw[1] : String(fw[0]) === w));
    if (!wOk) return false;
    if (!f.ranges) return true;
    for (const cp of cps) if (f.ranges.some(([a, b]) => cp >= a && cp <= b)) return true;
    return false;
  });
  const rules = await Promise.all(need.map(async (f) => {
    const uri = await toDataUri(f.url);
    return `@font-face{font-family:"${f.family}";font-style:${f.style};font-weight:${f.weight};src:url(${uri})${f.format ? ` format("${f.format}")` : ""};${f.rangeText ? `unicode-range:${f.rangeText};` : ""}}`;
  }));
  return { css: rules.join(""), count: need.length };
}

/** SVG 字串 → PNG Blob */
export async function svgToPng(svg, { width = 1080, height = 1350, fontCssUrl } = {}) {
  let out = svg;
  let fontInfo = { count: 0, error: null };
  if (fontCssUrl) {
    try {
      const { css, count } = await embeddedFontCss(svg, fontCssUrl);
      out = svg.replace(/<style>/, `<style>${css}`);
      fontInfo.count = count;
    } catch (e) {
      fontInfo.error = e.message;
    }
  }
  const blob = new Blob([out], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.width = width; img.height = height;
    img.src = url;
    await img.decode();
    // 給嵌入字型一點時間完成排版
    await new Promise((r) => setTimeout(r, 150));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return { png, fontInfo };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 觸發下載 */
export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
