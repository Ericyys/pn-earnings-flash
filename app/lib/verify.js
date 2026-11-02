// 圖卡數字核對：圖卡上的數字 vs 新聞稿的數字
//
// 分三類（rules/review_rules.md「圖卡數字核對」）：
//   match       四捨五入差異（例如 24.7% 對 25%）→ 自動通過，不提示
//   definition  定義（口徑）不同：新聞稿的數字等於工具算得出的另一種口徑（例如淨利含不含非控制權益、營收含不含避險損益）
//               → 不改圖卡數字，自動產生附註
//   error       哪一種口徑都對不上（科目抓錯行、單位錯）→ 必須修正：回到第二層改數字、交給 AI，或在公司規範調整算式
//   empty       沒有填（新聞稿沒有寫這個數字）
//
// 容許的四捨五入差異：新聞稿數字的最小位數一半＋圖卡數字的最小位數一半＋0.3%（連串四捨五入加總造成的小差異也視為四捨五入，
// 不另外揭露，避免把很小的差異放大）。

/** "−1,234.5"、"(12.3)"、"25%"、"$0.87"、"12.9B" → { value, decimals } */
export function parseInput(text) {
  let t = String(text ?? "").trim().replace(/[,\s$%]/g, "").replace(/[−–—]/g, "-").replace(/[BbMm億]$/, "");
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const m = /\.(\d+)$/.exec(t);
  return { value: neg ? -Number(t) : Number(t), decimals: m ? m[1].length : 0 };
}

export function classify(row, text) {
  const p = parseInput(text);
  if (String(text ?? "").trim() === "") return { status: "empty" };
  if (!p) return { status: "invalid" };
  const tol = (v) => 0.5 * Math.pow(10, -p.decimals) + 0.5 * Math.pow(10, -(row.decimals ?? 2)) + Math.abs(v) * 0.003;
  const near = (v) => Math.abs(v - p.value) <= tol(p.value);
  if (near(row.value)) return { status: "match" };
  for (const a of row.alts || []) {
    const hit = a.range ? p.value >= a.range[0] - tol(p.value) && p.value <= a.range[1] + tol(p.value) : near(a.value);
    if (!hit) continue;
    if (a.silent) return { status: "match", via: a.def };
    return { status: "definition", def: a.def, note: `${row.label}採${row.ours || "圖卡口徑"}；新聞稿為${a.def}。` };
  }
  // 抓錯：特別提示相差約 1,000 倍（單位錯）
  const ratio = row.value ? p.value / row.value : 0;
  const unit = [1000, 0.001, 100, 0.01].find((k) => ratio && Math.abs(ratio / k - 1) < 0.05);
  return { status: "error", hint: unit ? `相差約 ${unit >= 1 ? unit : `1/${1 / unit}`} 倍，可能是單位或位數有誤` : "與圖卡數字對不上，工具認得的其他口徑也都不符" };
}
