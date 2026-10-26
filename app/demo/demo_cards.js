// 示範數據：虛構公司 Demo Corp（代號 DEMO），只用來檢查版面，不是任何真實公司的財報。
// 正式使用時，這些 spec 由網頁從核對過的數據表自動產生（第 5 步）。

const header = { ticker: "DEMO", period: "2026Q3", label: "財報快報" };
const source = "資料來源：Demo Corp 2026Q3 財報新聞稿（2026-10-26）。示範數據，非真實公司。";

export const DEMO_CARDS = [
  {
    id: "A1", template: "T1", header, source,
    body: {
      ticker: "DEMO", company: "Demo Corp", period: "2026Q3",
      headline: "營收 USD 35.08B，年增 18.4%，高於公司財測上緣",
      kpis: [
        { label: "營收", unit: "USD B", value: 35.08, kind: "amount", delta: { value: 18.39, kind: "pct", label: "年增" }, note: "去年同期 29.63" },
        { label: "毛利率", unit: "%", value: 58.61, kind: "pct", delta: { value: 2.2, kind: "pp", label: "年變動" }, note: "去年同期 56.4%" },
        { label: "稀釋 EPS", unit: "USD", value: 1.42, kind: "perShare", delta: { value: 21.37, kind: "pct", label: "年增" }, note: "去年同期 1.17" },
      ],
    },
  },
  {
    id: "C", template: "T4", header, source,
    title: "每 100 元營收，留下 29.2 元淨利",
    body: {
      unit: "USD B",
      revenue: 35.08, cogs: 14.52, grossProfit: 20.56,
      opex: [{ name: "研發費用", value: 5.1 }, { name: "銷售費用", value: 3.02 }, { name: "管理費用", value: 1.48 }],
      otherOperating: 0, operatingIncome: 10.96,
      nonOperating: 1.25, tax: 1.98, netIncome: 10.23,
      margins: { gross: 58.61, operating: 31.24, net: 29.16 },
      note: "含處分投資利益 1.10（原文：Gain on sale of investments）",
    },
  },
  {
    id: "B", template: "T2", header, source,
    title: "雲端營收佔比升至 50.2%，年增 6.0 個百分點",
    body: {
      unit: "USD B", kind: "amount",
      periods: ["2025Q3", "2025Q4", "2026Q1", "2026Q2", "2026Q3"],
      series: [
        { name: "雲端", values: [13.1, 13.8, 14.6, 16.0, 17.6] },
        { name: "裝置", values: [9.2, 9.1, 8.95, 9.0, 9.05] },
        { name: "廣告", values: [5.1, 5.3, 5.5, 5.8, 6.1] },
        { name: "授權", values: [2.23, 2.2, 2.2, 2.3, 2.33] },
      ],
      table: {
        columns: ["業務", "2026Q3 營收", "佔比", "年增"],
        rows: [
          { name: "雲端", value: 17.6, share: 50.17, yoy: 34.35 },
          { name: "裝置", value: 9.05, share: 25.8, yoy: -1.63 },
          { name: "廣告", value: 6.1, share: 17.39, yoy: 19.61 },
          { name: "授權", value: 2.33, share: 6.64, yoy: 4.48 },
        ],
      },
    },
  },
  {
    id: "D", template: "T3", header, source,
    title: "營益率 31.2%，年增 3.7 個百分點，近 8 季最高",
    body: {
      unit: "%", kind: "pct",
      periods: ["2024Q4", "2025Q1", "2025Q2", "2025Q3", "2025Q4", "2026Q1", "2026Q2", "2026Q3"],
      series: [
        { name: "毛利率", values: [55.1, 55.8, 56.0, 56.4, 56.9, 57.2, 57.9, 58.6] },
        { name: "營益率", values: [26.0, 26.8, 27.1, 27.5, 28.4, 28.9, 30.1, 31.2] },
        { name: "淨利率", values: [21.5, 22.6, 22.9, 23.0, 24.1, 24.5, 26.0, 29.2] },
      ],
      table: {
        columns: ["指標", "2026Q3", "年變動", "季變動"], deltaKind: "pp",
        rows: [
          { name: "毛利率", value: 58.6, yoy: 2.2, qoq: 0.7 },
          { name: "營益率", value: 31.2, yoy: 3.7, qoq: 1.1 },
          { name: "淨利率", value: 29.2, yoy: 6.2, qoq: 3.2 },
        ],
      },
    },
  },
  {
    id: "E", template: "T6", header,
    source: "資料來源：Demo Corp 2026Q2、2026Q3 財報新聞稿；市場預期取自〔來源名稱〕（2026-10-25）。示範數據。",
    title: "營收 USD 35.08B，高於財測上緣 1.7%",
    body: {
      rows: [
        { label: "營收", unit: "USD B", kind: "amount", low: 33.5, high: 34.5, consensus: 34.2, actual: 35.08 },
        { label: "毛利率", unit: "%", kind: "pct", low: 57.0, high: 58.0, consensus: 57.8, actual: 58.6 },
        { label: "EPS", basis: "Non-GAAP", unit: "USD", kind: "perShare", consensus: 1.44, actual: 1.51 },
      ],
    },
  },
  {
    id: "G", template: "T5", header, source,
    title: "資本支出 USD 6.80B，年增 42.3%",
    body: {
      unit: "USD B", kind: "amount",
      steps: [
        { label: "營業現金流", value: 12.4, type: "total" },
        { label: "資本支出", value: 6.8, type: "use" },
        { label: "自由現金流", value: 5.6, type: "total" },
        { label: "庫藏股買回", value: 3.2, type: "use" },
        { label: "現金股利", value: 1.1, type: "use" },
        { label: "回饋後餘額", value: 1.3, type: "total" },
      ],
    },
  },
  {
    id: "I", template: "T7", header,
    source: "資料來源：各公司 2026Q3 財報新聞稿。示範數據，公司名稱為虛構。",
    title: "營收年增率 18.4%，5 家中排第 2",
    body: {
      metric: "2026Q3 營收年增率", unit: "%", kind: "pct",
      items: [
        { name: "DEMO", value: 18.4, focal: true },
        { name: "PEER A", value: 22.6 },
        { name: "PEER B", value: 12.1 },
        { name: "PEER C", value: 7.5 },
        { name: "PEER D", value: -2.3 },
      ],
    },
  },
  {
    id: "K1", template: "T8", header, source,
    title: "接下來看什麼",
    body: {
      sections: [
        {
          heading: "公司下季財測（2026Q4）", columns: ["項目", "財測區間"],
          rows: [
            { label: "營收（USD B）", value: "36.50–37.50" },
            { label: "毛利率（%）", value: "58.0%–59.0%" },
          ],
        },
        {
          heading: "下一個關注日期", columns: ["日期", "事件"],
          rows: [
            { label: "2026-12-10", value: "投資人日（公司公告）", text: true },
            { label: "2027-01-28", value: "2026Q4 財報公布（預計）", text: true },
          ],
        },
      ],
      teaser: { title: "完整拆解寫在路上", text: "下一篇拆解雲端業務的營收結構與成本變化。" },
    },
  },
  {
    id: "C-loss", template: "T4", header, source,
    title: "營業虧損 USD 0.62B，淨損 USD 0.48B",
    body: {
      unit: "USD B",
      revenue: 8.4, cogs: 5.1, grossProfit: 3.3,
      opex: [{ name: "研發費用", value: 2.2 }, { name: "銷售費用", value: 1.2 }, { name: "管理費用", value: 0.52 }],
      otherOperating: 0, operatingIncome: -0.62,
      nonOperating: 0.18, tax: 0.04, netIncome: -0.48,
      margins: { gross: 39.29, operating: -7.38, net: -5.71 },
    },
  },
];
