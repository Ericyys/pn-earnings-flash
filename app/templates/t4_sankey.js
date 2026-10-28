// T4｜損益流向圖（C 損益流向）
//
// body: {
//   unit: "USD B",
//   revenue, cogs, grossProfit,
//   opex: [{ name: "研發費用", value }, ...],      // 營業費用明細（加總＝營業費用合計）
//   otherOperating: 0,                             // 其他營業收益及費損淨額（可正可負，沒有填 0）
//   operatingIncome,
//   nonOperating: 0,                               // 業外收支淨額（可正可負）
//   tax,                                           // 所得稅費用（負數＝所得稅利益）
//   netIncome,
//   margins: { gross: 58.6, operating: 31.2, net: 26.4 },
//   note: "業外含處分投資利益 0.85（原文：Gain on sale of investments）"   // 選填，觸發 C 的標註規則時由網頁填入
// }
//
//   stopAt: "operating_income"                     // 選填：只畫到營業利益（不採用 PN 計算的業外數字時）
//
// 沒有營業成本（例如券商），或使用者不採用 PN 計算的毛利時，grossProfit 給 null：
// 營收直接分流到營業成本／各項費用／營業利益，圖少一欄。
//
// 所有金額都用公司報告值，底稿不自行計算毛利、營業利益、淨利。
// 只要毛利、營業利益或淨利 ≤ 0，或流量出現負值，流向圖無法正確表達，
// 回傳 null，由 templates/index.js 改用 T5 瀑布圖。

export function sankeyFlows(b) {
  const pos = (v) => Math.max(v || 0, 0);
  const neg = (v) => Math.max(-(v || 0), 0);
  const other = b.otherOperating || 0, nonop = b.nonOperating || 0, tax = b.tax || 0;
  // 有毛利節點：原文有營業成本，且毛利有數字（原文列出或使用者同意由 PN 計算）
  const hasGP = b.grossProfit !== null && b.grossProfit !== undefined && b.cogs > 0;
  // stopAt="operating_income"：使用者不採用 PN 計算的業外數字時，圖只畫到營業利益
  const toNI = b.stopAt !== "operating_income";
  if (hasGP && !(b.grossProfit > 0)) return null;
  if (!(b.operatingIncome > 0)) return null;
  if (toNI && !(b.netIncome > 0)) return null;

  const N = {};
  const add = (id, col, name, kind, extra = {}) => (N[id] = { id, col, name, kind, ...extra });
  const o = hasGP ? 0 : -1;          // 沒有毛利節點時，後面各欄往左移一欄
  const src = hasGP ? "gp" : "rev";  // 費用從哪個節點流出
  add("rev", 0, "營收", "total");
  if (hasGP) add("gp", 1, "毛利", "profit", { margin: ["毛利率", b.margins?.gross] });
  if (pos(other)) add("othGain", hasGP ? 1 : 0, "其他營業收益", "gain");
  const star = b.note ? "＊" : "";
  // 流入淨利的收益節點放在營業利益上方：流向帶水平進入淨利頂端，不與其他帶交錯
  if (toNI && pos(nonop)) add("nonGain", 2 + o, "業外收益" + star, "gain");
  if (toNI && neg(tax)) add("taxBen", 2 + o, "所得稅利益", "gain");
  add("oi", 2 + o, "營業利益", "profit", { margin: ["營益率", b.margins?.operating] });
  if (!hasGP && b.cogs > 0) add("cogs", 2 + o, "營業成本", "cost");
  b.opex.forEach((x, i) => add(`opex${i}`, 2 + o, x.name, "cost"));
  if (neg(other)) add("othLoss", 2 + o, "其他營業費損", "cost");
  if (hasGP) add("cogs", 1, "營業成本", "cost");
  if (toNI) {
    add("ni", 3 + o, "淨利", "profit", { margin: ["淨利率", b.margins?.net] });
    if (neg(nonop)) add("nonLoss", 3 + o, "業外損失" + star, "loss");
    if (pos(tax)) add("tax", 3 + o, "所得稅", "cost");
  }

  const L = [];
  if (hasGP) L.push(["rev", "gp", b.grossProfit], ["rev", "cogs", b.cogs]);
  else if (b.cogs > 0) L.push(["rev", "cogs", b.cogs]);
  L.push([src, "oi", b.operatingIncome - pos(other)]);
  b.opex.forEach((x, i) => L.push([src, `opex${i}`, x.value]));
  if (pos(other)) L.push(["othGain", "oi", pos(other)]);
  if (neg(other)) L.push([src, "othLoss", neg(other)]);
  if (toNI) {
    L.push(["oi", "ni", b.netIncome - pos(nonop) - neg(tax)]);
    if (pos(tax)) L.push(["oi", "tax", pos(tax)]);
    if (neg(nonop)) L.push(["oi", "nonLoss", neg(nonop)]);
    if (pos(nonop)) L.push(["nonGain", "ni", pos(nonop)]);
    if (neg(tax)) L.push(["taxBen", "ni", neg(tax)]);
  }

  if (L.some((l) => !(l[2] >= 0))) return null;
  // 沒有毛利節點時，營收直接分流：檢查流出合計＝營收（四捨五入容許 0.5%）
  if (!hasGP) {
    const out = L.filter((l) => l[0] === "rev").reduce((a, l) => a + l[2], 0);
    if (Math.abs(out - b.revenue) > Math.abs(b.revenue) * 0.005) return null;
  }
  return { nodes: N, links: L.map(([s2, t, v]) => ({ s: s2, t, v })) };
}

export function renderT4(box, ctx, spec) {
  const { c, st, measure, text, baseline, lineBox, rect, fmt, wrap } = ctx;
  const b = spec.body;
  const flows = sankeyFlows(b);
  if (!flows) return null;
  const { nodes, links } = flows;
  const lab = st("label");
  const small = st("small");
  let svg = "";

  svg += text(box.x, baseline(box.y, small), `單位：${b.unit}`, small, { fill: c.muted });
  const top = box.y + lineBox(small) + 32;
  // 標註（觸發 C 的業外／一次性項目規則時）放在圖下方
  let bottom = box.y + box.h;
  if (b.note) {
    const nl = wrap("＊" + b.note, small, box.w, measure);
    const nTop = bottom - nl.length * lineBox(small);
    nl.forEach((ln, i) => (svg += text(box.x, baseline(nTop + i * lineBox(small), small), ln, small, { fill: c.text2 })));
    bottom = nTop - 24;
  }


  // 節點數值＝max(流入, 流出)
  const ids = Object.keys(nodes);
  for (const id of ids) {
    const inV = links.filter((l) => l.t === id).reduce((a, l) => a + l.v, 0);
    const outV = links.filter((l) => l.s === id).reduce((a, l) => a + l.v, 0);
    nodes[id].value = Math.max(inV, outV);
    nodes[id].display = { rev: b.revenue, gp: b.grossProfit, cogs: b.cogs, oi: b.operatingIncome, ni: b.netIncome }[id] ?? nodes[id].value;
  }
  const nCols = Math.max(...ids.map((id) => nodes[id].col)) + 1;
  const cols = [...Array(nCols).keys()].map((ci) => ids.filter((id) => nodes[id].col === ci));

  // 標籤內容與高度
  const labelLines = (n) => {
    const lines = [{ str: n.name, fill: c.text2, st: lab }];
    const sign = n.kind === "cost" || n.kind === "loss" ? fmt.MINUS : "";
    lines.push({ str: sign + fmt.amount(n.display), fill: c.text, st: lab, num: true });
    if (n.margin && n.margin[1] !== undefined) lines.push({ str: `${n.margin[0]} ${fmt.pct(n.margin[1])}`, fill: c.muted, st: lab, num: true });
    return lines;
  };
  const nodeW = 14;
  const lastCol = cols[nCols - 1];
  const labelW3 = Math.max(...lastCol.map((id) => Math.max(...labelLines(nodes[id]).map((l) => measure(l.str, lab, l.num)))));
  const colGap = (box.w - nodeW - labelW3 - 12) / (nCols - 1);
  const colX = (ci) => box.x + ci * colGap;

  // 垂直比例：所有欄位都要放得下
  const pad = lineBox(lab) * 3 + 8;
  const H = bottom - top;
  const k = Math.min(...cols.map((col) => (H - pad * (col.length - 1)) / col.reduce((a, id) => a + nodes[id].value, 0)));

  // 節點位置（各欄頂端對齊）
  cols.forEach((col) => {
    let yy = top;
    col.forEach((id) => {
      const n = nodes[id];
      n.x = colX(n.col);
      n.y = yy;
      n.h = Math.max(n.value * k, 1);
      yy += n.h + pad;
    });
  });

  // 結果項依正負上色：利潤節點（毛利、營業利益、淨利）≥ 0 用 pn-up，< 0 用 pn-down。
  // 扣減項（營業成本、各項費用、所得稅）一律 pn-chart-other，不因負值改色。業外收益 pn-up、業外損失 pn-down。
  const KIND_COLOR = { total: c.text, cost: c.other, loss: c.down, gain: c.up };
  const nodeColor = (n) => (n.kind === "profit" ? (n.display >= 0 ? c.up : c.down) : KIND_COLOR[n.kind]);
  const op = 0.3; // 流向帶為節點顏色的 30% 透明度

  // 流向帶：來源端依目標順序、目標端依來源順序堆疊；帶與帶之間留 1px 縫
  const order = (id) => {
    const n = nodes[id];
    return n.col * 1000 + cols[n.col].indexOf(id);
  };
  const outOff = {}, inOff = {};
  ids.forEach((id) => (outOff[id] = inOff[id] = 0));
  const outSorted = [...links].sort((a, b2) => order(a.s) - order(b2.s) || order(a.t) - order(b2.t));
  const pos = new Map();
  outSorted.forEach((l) => {
    pos.set(l, { sy: nodes[l.s].y + outOff[l.s] });
    outOff[l.s] += l.v * k;
  });
  [...links].sort((a, b2) => order(a.t) - order(b2.t) || order(a.s) - order(b2.s)).forEach((l) => {
    pos.get(l).ty = nodes[l.t].y + inOff[l.t];
    inOff[l.t] += l.v * k;
  });
  for (const l of links) {
    const t = Math.max(l.v * k - 1, 0.5);
    const { sy, ty } = pos.get(l);
    const xs = nodes[l.s].x + nodeW, xt = nodes[l.t].x;
    const mx = (xs + xt) / 2;
    const d = `M${xs},${sy}C${mx},${sy} ${mx},${ty} ${xt},${ty}L${xt},${ty + t}C${mx},${ty + t} ${mx},${sy + t} ${xs},${sy + t}Z`;
    // 流向帶顏色跟著目標節點；流入淨利的業外收益帶維持 pn-up
    const fill = nodes[l.s].kind === "gain" ? c.up : nodeColor(nodes[l.t]);
    svg += `<path d="${d}" fill="${fill}" fill-opacity="${op}"/>`;
  }
  for (const id of ids) {
    const n = nodes[id];
    svg += rect(n.x, n.y, nodeW, Math.max(n.h - 1, 1), nodeColor(n));
  }

  // 標籤位置：第一欄與終點節點（沒有流出）放右側；中間節點放左側，
  // 避免文字壓在往右發散的細流向帶上。同一欄、同一側的標籤互相避讓。
  const hasOut = (id) => links.some((l) => l.s === id);
  const sideOf = (n) => (n.col === 0 || !hasOut(n.id) ? "right" : "left");
  const groups = [];
  cols.forEach((col) => ["left", "right"].forEach((side) => {
    const g = col.filter((id) => sideOf(nodes[id]) === side);
    if (g.length) groups.push({ side, ids: g });
  }));
  groups.forEach(({ side, ids: col }) => {
    const items = col.map((id) => {
      const n = nodes[id];
      const lines = labelLines(n);
      const h = lines.length * lineBox(lab);
      return { n, lines, h, y: n.y + n.h / 2 - h / 2 };
    });
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      if (items[i].y < prev.y + prev.h + 8) items[i].y = prev.y + prev.h + 8;
    }
    const last = items[items.length - 1];
    const overflow = last.y + last.h - bottom;
    if (overflow > 0) items.forEach((it) => (it.y -= overflow));
    if (items[0].y < top - lineBox(lab)) items[0].y = top - lineBox(lab);
    items.forEach((it) => {
      const right = side === "right";
      const x = right ? it.n.x + nodeW + 12 : it.n.x - 12;
      it.lines.forEach((ln, i) => {
        svg += text(x, baseline(it.y + i * lineBox(lab), lab), ln.str, lab, { fill: ln.fill, num: ln.num, anchor: right ? "start" : "end" });
      });
    });
  });
  return svg;
}
