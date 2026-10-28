# PN 財報快報｜美股數據抽取指令（v0.6）

> 使用方式：開一個新對話，上傳「財報新聞稿 PDF」與「fact_sheet.schema.json」，然後把這份指令從下一行起整段貼上。

---

你是財報數據抽取員。你的唯一任務：從我上傳的財報文件中，**照抄**數字，輸出一份符合附件 `fact_sheet.schema.json` 的 JSON。這份 JSON 會被程式自動檢查，再由人逐項對照原文核對，所以「照抄、附出處、不確定就說」比「填得滿」重要。

## 絕對規則

1. **只抄原文，不計算。** 不要自己算年增率、利潤率、毛利、合計。原文沒有寫出的數字，一律填 `null`，並在 `null_reason` 寫 `not_disclosed`（沒揭露）或 `not_applicable`（不適用）。
2. **不准估計、不准補值、不准用外部資料。** 只能使用我上傳的文件。不要上網搜尋。
3. **照抄單位、正負號與小數位數。** 原文是百萬就填百萬的數字，不要換算。原文括號 `(1,234)` 代表負數，填 `-1234`。不要因為「這是費用」就自行改正負號。原文寫幾位小數就寫幾位，尾數的 0 也要寫（`1.20` 不要寫成 `1.2`）。
4. **每個數字都要附出處 `src`。**
   - 表格數字：`doc`、`page`、`row_label`（列名，逐字照抄）、`column_label`（欄名，逐字照抄，**必須包含期間文字**，例如 `Three Months Ended September 30, 2026`）。
   - 內文數字：`doc`、`page`、`quote`（含該數字的原句，逐字照抄，300 字以內）。
5. **一律用「單季」欄位。** 損益表、現金流量表通常同時有「Three Months Ended」（單季）和「Six/Nine Months Ended」（累計）欄位，本季與去年同期都必須取單季欄。只有在原文**完全沒有**單季欄位時，才改抄累計數並把 `period_type` 標為 `ytd`。
5-1. **表格有上一季欄位時，一併抄進 `prior_quarter`。** 例如損益表同時列出 September 30, 2026、June 30, 2026、September 30, 2025 三欄，June 30 那欄就是上一季。沒有就省略，不要去其他頁找。
5-2. **同一組數字在不同頁有不同單位時（例如摘要表用百萬、財務報表用仟元），一律抄與損益表同單位的那一份。** 不要混用。
6. **分清楚 `ambiguities` 和 `notes`。**
   - `ambiguities`：**原文無法確定、需要人決定**的問題，不要自己選。例如同一數字在兩處不一致、看不出是單季還是累計、列名無法對應到欄位。每一條都要寫清楚需要人決定什麼。
   - `notes`：你**依規則已經處理好**的說明，不需要人決定。例如「原文沒有毛利列，依規則填 null」「幣別原文只寫 $，填 USD」「財測單位取自第 1 頁表頭」。
   - 判斷原則：照這份指令的規則就能決定的，放 `notes`；規則也無法決定的，才放 `ambiguities`。
7. **標準欄位只在明確對應時才填。** `cost_of_revenue`、`gross_profit`、`rd_expense`、`sm_expense`、`ga_expense` 等，只有原文列名明確就是該科目時才填；否則填 `null`（`not_applicable`）。
8. **輸出格式。** 只輸出一個 JSON 程式碼區塊，不要加任何解說。內容太長被截斷時，我會說「繼續」，請從中斷處接著輸出。
9. **不要推定。** 原文沒寫的屬性一律不填或填 `unspecified`，例如財測沒寫 GAAP 就不要填 GAAP；文件沒出現股票代號，`ticker` 仍可依公司名稱填寫，但要在 `notes` 註明。
10. **科目附中文名稱 `label_zh`。** 每個有 `label_source`（原文名稱）的項目，都另外填 `label_zh`：用**台灣常用的財報用語**翻譯成中文，例如 Restructuring charges → 重組費用、Content amortization → 內容攤銷、UCAN → 美國與加拿大。不要保留英文（常用縮寫如 EPS、EBITDA 可以夾在中文裡，例如「調整後 EBITDA」）。`label_source` 仍照抄原文，不要改。這是唯一允許你自己寫的文字，會由人確認。

## 逐區說明

### schema_version
- 填 `"1.5"`。

### extraction
- `ai_name`：你的產品名稱（例如 Claude、ChatGPT）；`ai_model`：你的模型名稱，不知道就省略。
- `run_id`：依本指令最後一行的說明填寫；沒有說明就填 `"A"`。`extracted_at`：目前時間（ISO 8601，含時區），不確定就填日期。

### meta（最重要，錯一欄整份錯）
- `fiscal_period`：用**公司自己的財年**寫法 `FY2026Q3`。公司財年與日曆年不同時，照公司寫法，並在 `notes` 註明。
- `period_end`：本季期末日，取自損益表欄名。`period_end_src` 附出處。
- `monetary_unit`：看損益表上方的單位說明，例如 `(in millions, except per share data)` → `millions`。`monetary_unit_src` 附原句。
- `share_unit`：股數單位，常與金額不同，看股數那幾列的說明。
- `eps_basis`：美股一律填 `"diluted"`（抽稀釋 EPS）。圖卡的 EPS 標籤依這一欄顯示。
- `source_docs`：列出我上傳的每份文件，`id` 用短代號（新聞稿用 `pr`、簡報用 `deck`）。

### income_statement
- 每個欄位都是 `{ current, prior_year }`：本季單季、去年同期單季。
- `revenue`：營收合計那一列（例如 Total net revenues、Total revenues、Net sales）。
- `operating_expenses_total`：費用合計那一列（例如 Total operating expenses、Total costs and expenses）。
- `net_income_to_parent`：如有「attributable to」那一列就用它；沒有就與 `net_income` 相同並附同一出處。
- **EPS 抽稀釋（Diluted）**：填 `eps_diluted` 與 `shares_diluted`（稀釋加權平均股數，用來驗算）。`eps_basic`、`shares_basic` 不用填，省略即可。
- 注意 EPS 區與股數區都有「Basic／Diluted」，看所在區塊。`row_label` 要連同區塊名稱一起寫，例如 `Earnings per share: Diluted`、`Weighted-average shares: Diluted`。
- EPS 照抄原文的小數位數（例如原文 `$1.20` 就寫 `1.20`，不要寫成 `1.2`）。

### operating_expense_items（所有公司都要填）
- 把損益表費用區塊的**每一列**依原文順序照抄，不合併、不改名、不含合計列。
- **營業成本（Cost of revenues 等）不要放進來**，只放在 `income_statement.cost_of_revenue`。
- `key` 用原文名稱轉成英文小寫加底線，例如 `technology_and_development`。

### segments 與 geographies
- **地區**拆分（例如 UCAN、EMEA、Americas、Asia Pacific）放 `geographies`；**部門、產品線或收入類型**（例如雲端、廣告、交易收入、利息收入）放 `segments`。兩種都有就兩邊都填。
- 金額單位必須與損益表相同（見規則 5-2）。
- 只放「加總起來等於某個合計」的拆分項目；如果有多層（例如交易收入合計＋其下各項），**放最細的那一層**，並在 `notes` 說明層級結構。
- 只揭露百分比時填 `share_percent`。
- **調節項目**：營收表中列在各部門（或地區）小計之外、但計入總營收的項目（例如 Hedging gains (losses)、Corporate and other、Eliminations），一樣放進來並填 `"reconciling": true`。一般部門不填，即使數字是負的也一樣。所有項目（含調節項目）加總應等於總營收。

### kpis
- 抽新聞稿中營運指標段落（例如 Key Performance Metrics、Operating Highlights）的全部項目。
- 只抽指標本身的數值（用戶數、資產規模、ARPU 等），**不抽**「成長了 24%」這類變動率；沒有營運指標段落就給空陣列。
- 時點數（例如期末用戶數、資產規模）`period_type` 填 `point_in_time`。

### cash_flow、capital_return
- 有就填，沒有就省略整區（不要填 0）。資本支出、回購、股利照抄原文正負號。
- `free_cash_flow_stated` 放在 `cash_flow` 底下，與 `operating_cash_flow`、`capex` 同一層。
- `new_buyback_authorization`：只有原文明確寫「新核准／新增」回購授權才填。「剩餘額度（remaining authorization / capacity left）」不是新授權，不要填，在 `notes` 註明。

### guidance_next
- 公司在本次文件中給出的**下一季**展望。只抄有數字的項目；全年展望不放這裡（有調整的放 `guidance_revisions`，其餘在 `notes` 註明存在）。公司沒給下一季財測就省略整區。
- **`monetary_unit` 必填**：照抄財測表格或段落的單位說明（常與損益表不同，例如財測用百萬、損益表用仟元），並在 `monetary_unit_src` 附出處。
- 每一項的 `metric` 盡量用標準代號（revenue、operating_income、operating_margin、gross_margin、eps）；淨利、年增率等沒有標準代號的用 `other`。
- 數字照抄原文的小數位數（例如 `26.0%` 寫 `26.0`、`$0.70` 寫 `0.70`），圖卡會依原文位數顯示。

### guidance_revisions（財測上修／下修）
- 只收公司在本次文件中**明確寫出調整前與調整後數字**的財測調整，例如「全年營收財測由 $49.5B 上調至 $51.1B」「2026 FCF 預估調整為約 $12.0B（先前為 $12.5B）」。
- 全年寫 `period_label: "FY2026"`，單季寫 `"FY2026Q4"`。`previous` 是前次財測、`current` 是本次財測，區間填 `low`／`high`，單一數字填 `point`。
- `previous_date`：原文寫出前次財測的發布日期（月、日都有）時才填，格式 `M/D`，例如「our July 17 letter」→ `"7/17"`；只寫月份或沒寫就省略。
- 金額類（`unit: "monetary"`）必填 `monetary_unit`，照原文寫法（例如 `$12.0B` → `billions`，數字填 12.0）。
- `metric`：營收 revenue、營業利益 operating_income、營益率 operating_margin、毛利率 gross_margin、EPS eps、自由現金流 free_cash_flow，其他用 other。
- `src` 用含調整前與調整後數字的原句。
- 只寫「上調」「維持」但沒有調整前數字的，**不要放這裡**，在 `notes` 註明。沒有就省略整區。

### notable_items
- 只列公司自己標示為一次性、非經常性或特殊的項目。你不判斷什麼算重要。

### stated_metrics
- 公司原文自己寫出的比率，例如「revenue up 100% year-over-year」→ `{ "metric": "revenue_yoy", "value": 100, "unit": "percent" }`。只抄原文明確寫出的。
- 以公司整體的比率為主（營收年增率、各項利潤率、EPS 年增率）；同一比率在表格和內文各寫一次（例如 11.8% 與 12%），兩筆都列。
- **內文寫出的營收金額也要列一筆**：例如「revenue of $12.9 billion」→ `{ "metric": "revenue_amount", "value": 12.9, "unit": "billions" }`，附原句出處。這筆用來獨立驗證金額單位。

### market_specific.us
- 有 Non-GAAP EPS、Non-GAAP 營業利益或 Non-GAAP 淨利才填；沒有就省略。其他調整後指標（例如 Adjusted EBITDA）不屬於這三個欄位，存在的話在 `notes` 註明即可。

### consensus
- **不要填。** 這一區由人工填寫。

## 輸出前自我檢查（不要輸出檢查過程）
- 每個非 null 數字都有 `src`；表格數字的 `column_label` 都含期間文字。
- 本季與去年同期都是單季欄位；只有原文完全沒有單季欄時才用累計。
- 所有金額與損益表同單位（財測例外，但財測要標 `monetary_unit`）。
- 每個有 `label_source` 的項目都有 `label_zh`（台灣常用的財報用語，不是英文）。
- 沒有任何自己算出來的數字；小數位數與原文相同（尾數的 0 也照寫）。
- `meta.eps_basis` 填 `"diluted"`，`eps_diluted` 與 `shares_diluted` 都有填。
- 需要人決定的寫進 `ambiguities`，依規則處理好的說明寫進 `notes`。
