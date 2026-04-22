export type FaeDataKind = "log" | "csv" | "unknown";

export type MockReportInput = {
  fileName: string;
  byteLength: number;
  excerpt: string;
  kind: FaeDataKind;
};

export function inferDataKind(fileName: string, mimeType: string): FaeDataKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv") || mimeType.includes("csv")) return "csv";
  if (
    lower.endsWith(".log") ||
    lower.endsWith(".txt") ||
    mimeType.startsWith("text/")
  ) {
    return "log";
  }
  return "unknown";
}

/**
 * Deterministic mock report for demo / integration tests.
 * Later this body will be replaced by real LLM output grounded in parsed logs & CSV stats.
 */
export function buildMockFaeReportMarkdown(input: MockReportInput): string {
  const { fileName, byteLength, excerpt, kind } = input;
  const preview =
    excerpt.trim().length > 0
      ? excerpt.trim().slice(0, 1200)
      : "（檔案無文字預覽）";

  const kindLabel =
    kind === "csv" ? "品管 CSV" : kind === "log" ? "測試 Log" : "未分類資料";

  return [
    `# FAE 自動化分析報告（Demo）`,
    ``,
    `## 資料來源`,
    `- **檔名**：\`${fileName}\``,
    `- **類型**：${kindLabel}`,
    `- **大小**：${byteLength.toLocaleString()} bytes`,
    ``,
    `## 摘要`,
    `此報告由 **模擬 Agent 流程** 產生，用於驗證上傳 → 串流 API → Markdown 預覽。正式環境將改為：`,
    `1. 結構化解析 Log / CSV`,
    `2. 以規格與統計方法標記 **Outlier** 與 **Spec 符合性**`,
    `3. 由 LLM 產出可追蹤的 FAE 建議與下一步實驗計畫`,
    ``,
    `## 原始內容摘錄（前段）`,
    "```text",
    preview,
    "```",
    ``,
    `## 異常與規格檢查（示意）`,
    "| 檢查項目 | 結果 | 說明 |",
    "| --- | --- | --- |",
    "| Outlier scan | **Pass（Demo）** | 尚未接入真實統計；預留 IQR / 3σ 欄位 |",
    "| Spec gate | **Review** | 需匯入實際上下限與測試條件後判定 |",
    "| Log 完整性 | **Info** | 建議比對測試腳本版本與硬體配置 hash |",
    ``,
    `## FAE 建議（Agent 視角）`,
    `- 將 **測試條件**（溫度、電壓、韌體版次）與 **量測欄位** 正規化後再餵給 LLM，可顯著降低幻覺。`,
    `- CSV：先計算每欄 **Cp/Cpk 或簡易趨勢**，把統計摘要一併送入 prompt。`,
    `- Log：對時間序列欄位做 **突變點偵測**，再請模型解釋「可能根因假說」。`,
    ``,
    `---`,
    `_本段為 Mock 輸出，僅供 UI / 串流管線驗證。_`,
  ].join("\n");
}
