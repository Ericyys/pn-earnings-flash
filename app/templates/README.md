# 圖卡底稿 T1–T8

每種底稿是一個函式：吃進一份 `spec`（這張圖卡要畫什麼），吐出 1080×1350 的 SVG。
頁首、標題、來源行、免責、署名由 `lib/frame.js` 統一處理，底稿只畫中間的內容區。

## 預覽

- 本機：在 repo 根目錄執行 `python3 -m http.server`，開啟 `http://localhost:8000/app/demo/preview.html`
- GitHub Pages 開啟後：`https://<帳號>.github.io/pn-earnings-flash/app/demo/preview.html`

預覽頁使用 `demo/demo_cards.js` 的示範數據（虛構公司 Demo Corp）。圖卡只使用淺底（業主決定）。

## 底稿與模組對照

| 底稿 | 圖型 | 用於 | 檔案 |
|---|---|---|---|
| T1 | 大數字卡 | A1 封面 | `t1_cover.js` |
| T2 | 堆疊／單一長條圖＋拆解表 | B 營收拆解、F 營運指標 | `t2_bars.js` |
| T3 | 折線圖＋變動表 | D 獲利能力、F 趨勢 | `t3_lines.js` |
| T4 | 損益流向圖 | C 損益流向 | `t4_sankey.js` |
| T5 | 瀑布圖 | G 資本配置、B 成長歸因、C 虧損替代版 | `t5_waterfall.js` |
| T6 | 區間圖 | E 對比預期 | `t6_range.js` |
| T7 | 橫條圖 | I 同業對比 | `t7_hbar.js` |
| T8 | 清單卡 | K1 下一步與預告 | `t8_checklist.js` |

每個檔案開頭都有該底稿的輸入格式說明，`demo/demo_cards.js` 有完整範例。

## 共通 spec 欄位

```js
{
  template: "T2",
  theme: "light",                      // 只使用淺底
  header: { ticker: "DEMO", period: "2026Q3", label: "財報快報" },
  title: "雲端營收佔比升至 50.2%，年增 6.0 個百分點",   // 由標題公式產生（第 5 步）
  source: "資料來源：Demo Corp 2026Q3 財報新聞稿（2026-10-26）",
  body: { ... }                        // 各底稿自己的內容
}
```

## 底稿層的固定規則

- 所有數字經過 `lib/format.js` 格式化：千分位、金額 2 位、百分比 1 位、`▲ 5.2%`、負值用 `−`。
- 漲跌箭頭用漲藍跌橘；箭頭後的數字一律主文字色（「圖上文字不用資料色」）。
- 分類色依固定順序使用，第 7 類起併入 other 灰。
- 標題兩行時優先在「，」後斷行，不在詞與數字之間斷開。
- **T4 自動改用 T5**：毛利、營業利益或淨利 ≤ 0 時流向圖無法正確表達，會自動改畫損益瀑布圖，預覽頁會標示。
- 底稿不計算任何要印出來的數字（毛利、營業利益、淨利都用公司報告值）。計算與驗算在 QC 與計算階段完成。
