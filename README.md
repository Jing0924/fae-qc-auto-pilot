# FAE Auto Pilot Demo

以 **Next.js** 建置的示範應用：上傳測試 **Log** 或品管 **CSV**，由 **Google Gemini** 串流產生繁體中文 **FAE（現場應用工程師）分析報告**，並可併入產品規格（示範檔或自訂內容）以對照規格與實測。

## 功能摘要

- **多檔上傳**：一次可選多份檔案，每份產一則可收合預覽的 Markdown 報告；亦可將當次產出的全部報告一次下載為 **ZIP**。
- **規格模式**：內建示範規格、不上傳規格、或貼上自訂 Markdown 規格。
- **CSV 前處理**：伺服器端解析與數值摘要，圖表預覽（Recharts）輔助閱讀。
- **QC 歷史比對**（可選）：啟用後走多步 **Agent** 流程，與 `public/samples` 內歷史示範 CSV 比對（IDDQ、Fmax、Yield 等指標，依實作為準）。

## 環境變數

| 變數 | 說明 |
| --- | --- |
| `GEMINI_API_KEY` | **必填。** Google AI Studio / Gemini API 金鑰；未設定時 API 會回傳明確錯誤。 |
| `GEMINI_MODEL` | 選填。預設 `gemini-2.5-flash`。 |

本機可於專案根目錄建立 `.env.local`（勿提交到版本庫）：

```bash
GEMINI_API_KEY=your_key_here
# GEMINI_MODEL=gemini-2.5-flash
```

## 本機開發

需 **Node.js**（建議與本機 Next.js 16 相容的現行 LTS 版本）。

```bash
npm install
npm run dev
```

瀏覽器開啟 [http://localhost:3000](http://localhost:3000)。

其餘指令：

```bash
npm run build   # 正式建置
npm run start   # 以建置結果啟動
npm run lint    # ESLint
```

## 範例檔

靜態範例置於 `public/samples/`（首頁亦有下載連結），例如：

- `demo-product-spec-zh.md`：示範產品規格（繁中 Markdown）
- `fake-qc-lot-*.csv`：示範品管批次 CSV
- `fake-test-run.log`：示範測試 log
- `test-run-all-pass.log`、`test-run-all-fail.log`、`test-run-few-errors.log`：情境測試用 log 範例

## 實作備註

- 報告由 **Vercel AI SDK**（`@ai-sdk/google`）串流產生；上傳大小與送入模型的文字長度在 API 路由內有上限（示範／Demo 用）。
- 本專案使用 **Next.js App Router**（`src/app`），重要邏輯在 `src/lib/fae/` 與 `src/app/api/report/route.ts`。

## 授權

`private` 示範專案；未附開源授權條款。
