# 圖卡底稿 T1–T8

每種底稿是一個函式：吃進一份 `spec`（這張圖卡要畫什麼），吐出 1080×1350 的 SVG。
頁首、頁尾（資料來源＋免責＋署名）由 `lib/frame.js` 統一處理，底稿只畫中間的內容區。
配色、字型、字級一律讀 `app/brand.json`，規範說明見 `references/card_style.md`。

## 預覽

修改底稿或 `brand.json` 後，用預覽頁檢查所有底稿（示範數據為虛構公司 Demo Corp）：

- GitHub Pages：`https://<帳號>.github.io/pn-earnings-flash/app/demo/preview.html`
- 本機：在 repo 根目錄執行 `python3 -m http.server`，開啟 `http://localhost:8000/app/demo/preview.html`

## 底稿與模組對照

| 底稿 | 圖型 | 用於 | 檔案 |
|---|---|---|---|
| T1 | 大數字卡 | A1 封面 | `t1_cover.js` |
| T2 | 堆疊／單一長條圖，最後一根右側標名稱、金額、年增；負值畫在 0 軸下方，柱頂標財報淨額 | B 營收拆解、F 營運指標 | `t2_bars.js` |
| T3 | 折線圖；兩期時為斜線圖 | D 利潤率、F 趨勢 | `t3_lines.js` |
| T4 | 損益流向圖 | C 損益流向 | `t4_sankey.js` |
| T5 | 瀑布圖 | G 現金流量與股東回饋、C 虧損替代版 | `t5_waterfall.js` |
| T6 | 區間圖 | E 對比預期 | `t6_range.js` |
| T7 | 橫條圖 | I 同業對比 | `t7_hbar.js` |
| T8 | 清單卡（兩欄或三欄表格；項目名稱過長自動換行，數字欄寬固定） | K1 下季財測／財測調整 | `t8_checklist.js` |

每個檔案開頭都有該底稿的輸入格式說明，`demo/demo_cards.js` 有完整範例。

## 共通 spec 欄位

```js
{
  template: "T2",
  header: { ticker: "DEMO", period: "2026Q3", label: "營收組成" },   // 頁首：代號 · 季度 · 圖名
  source: "資料來源：Demo Corp 2026Q3 財報新聞稿（2026-10-26）。",    // 會與免責合併放在頁尾
  title: "公司下季財測（2026Q4）",     // 只有 T8 使用；中間的圖卡只放圖，不放標題
  body: { ... }                        // 各底稿自己的內容
}
```

## 底稿層的固定規則

- 所有數字經過 `lib/format.js` 格式化：千分位、金額 2 位、百分比 1 位、`▲ 5.2%`、負值用 `−`。
- 原文直接抽取、未經換算的數字（EPS、財測）不用固定位數：spec 帶 `decimals`（T1）或由 `compute.js` 先依原文位數排好文字（T8），位數紀錄見 `lib/decimals.js`。
- 漲跌箭頭用漲藍跌橘；箭頭後的數字一律主文字色。
- 正負色只用在結果項（利潤、虧損、業外損益）；扣減項（成本、費用、資本支出、股東回饋）一律 other 灰。
- 分類色依固定順序使用，第 7 類起併入 other 灰。圖例與標籤用 8×8 方塊。
- **T4 自動改用 T5**：毛利、營業利益或淨利 ≤ 0 時流向圖無法正確表達，會自動改畫損益瀑布圖。
- 底稿不計算任何要印出來的數字；計算與驗算在 `lib/compute.js` 完成。
