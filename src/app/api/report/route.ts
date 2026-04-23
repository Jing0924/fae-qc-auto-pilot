import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText } from "ai";
import { inferDataKind } from "@/lib/fae/build-mock-report";
import { computeCsvNumericSummary } from "@/lib/fae/csv-numeric-summary";
import { parseCsvForAnalysis } from "@/lib/fae/parse-csv-for-analysis";
import {
  formatSpecThresholdDeviations,
  parseColumnThresholdsJson,
} from "@/lib/fae/csv-spec-thresholds";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 512 * 1024;
/** Upper bound for text sent to the model (full file if shorter). */
const MAX_TEXT_CHARS = 32_000;

/**
 * 目標報告字元上限（含標點與換行）。本機／快速測試用；上線前可刪除或改為環境變數。
 */
const DEMO_MAX_REPORT_CHARS = 5000;
/**
 * 模型輸出 token 上限（硬限制）。此為 token 數，與中文字元數非固定比例，不保證剛好等於
 * {@link DEMO_MAX_REPORT_CHARS} 字；若日後要嚴格截斷字元數，需在串流層額外實作。
 */
const DEMO_MAX_REPORT_OUTPUT_TOKENS = 8196;

const FAE_SYSTEM_PROMPT = [
  "你是資深 FAE（現場應用工程師）兼品管分析顧問。",
  "使用者會上傳測試 log 或品管 CSV 等文字內容（可能已截斷）。",
  "分析時請**先**對照系統所附之「產品規格（Demo 或自訂）」與門檻掃描／數值摘要，再談趨勢、離群與改善建議；敘事須以規格與實測的對照為主軸。",
  "",
  `【最重要的硬性限制】整份報告總長度必須嚴格控制在 ${DEMO_MAX_REPORT_CHARS} 字元以內（含標點、空白與換行，中英文皆計為 1 字元）。`,
  `- 這是硬限制，絕不可超過；請在產出前預估長度，若逼近上限必須主動精簡，優先保留最重要的結論與行動建議。`,
  `- 請務必完整收尾（包含最後的 Next steps 章節），不要在句子中間或章節中途結束。`,
  `- 寧可每章節精簡（2〜4 行即可），也不要讓報告被截斷。條列優先於長段落。`,
  "",
  "請一律使用繁體中文撰寫，並遵守：",
  "- 僅根據本次提供的檔案內容與**系統附帶之規格／摘要**推論；不得虛構規格中未出現的數值或條文；若資訊不足，明確標示不確定性。",
  "- 區分「觀察到的現象」與「假設／可能根因」；假設需列出，並建議可驗證的下一步（量測、交叉比對、實驗設計）。",
  "- 若偵測到可能 outlier 或異常趨勢，說明依據（欄位、數值、與周遭資料對比），並標註信心程度。",
  "- 當使用者的提示內含「## 系統預先計算之數值摘要」等系統產生之統計時，報告中引用的 n、各欄 min／max、平均、標準差、中位數、IQR 離群之列號與數值，必須與該摘要完全一致，不得虛構或竄改；若摘要以括號註明「無法產生數值統計」或等效說明，則僅能依內文摘錄推論，並可簡要說明缺統計之原因。",
  "- Spec／USL-LSL：須**引用**規格段落或表格內的具體數值作符合性敘述；若提示未提供，表格中填「待補」，並列出需要補齊的欄位。",
  "",
  "輸出格式：結構化 Markdown，至少包含以下章節（可視內容調整小標，但保留意涵）：",
  "## 摘要",
  "## 資料理解（格式、欄位、時間／批次脈絡）",
  "## 觀察與異常／Outlier 假說",
  "## Spec 與符合性檢查（條文或表格對照；不足處標待補）",
  "## FAE 建議與 Next steps（含驗證步驟）",
  "",
  `再次提醒：全文（含所有章節標題、標點、換行）總字元數不得超過 ${DEMO_MAX_REPORT_CHARS}。請在字數預算內完整交付所有章節。`,
].join("\n");

function loadDemoSpecMarkdown(): string {
  try {
    const p = join(
      /* turbopackIgnore: true */ process.cwd(),
      "public",
      "samples",
      "demo-product-spec-zh.md",
    );
    return readFileSync(p, "utf8");
  } catch {
    return "（系統：無法載入示範規格檔。）\n";
  }
}

function getFormString(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v === "string") return v;
  return null;
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return Response.json(
      { error: "Expected Content-Type: multipart/form-data" },
      { status: 400 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: 'Missing "file" field (File)' },
      { status: 400 },
    );
  }

  const notes = getFormString(form, "notes")?.trim() ?? "";
  const thresholdsJson = getFormString(form, "thresholdsJson");
  const specModeRaw = getFormString(form, "specMode");
  const specMode =
    specModeRaw === "none" || specModeRaw === "custom" || specModeRaw === "demo"
      ? specModeRaw
      : "demo";
  const customSpec = getFormString(form, "customSpec")?.trim() ?? "";

  if (file.size === 0) {
    return Response.json({ error: "Empty file" }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: `File too large (demo limit ${MAX_FILE_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      {
        error:
          "伺服器未設定 GEMINI_API_KEY，無法呼叫生成式模型。請於部署環境設定後重試。",
      },
      { status: 500 },
    );
  }

  let fullText: string;
  try {
    fullText = await file.text();
  } catch {
    return Response.json({ error: "Could not read file as text" }, { status: 400 });
  }

  const kind = inferDataKind(file.name, file.type);
  const truncated = fullText.length > MAX_TEXT_CHARS;
  const excerpt = truncated ? fullText.slice(0, MAX_TEXT_CHARS) : fullText;

  const bodyNote = truncated
    ? `\n\n（以下為截斷後內容，原始約 ${fullText.length.toLocaleString()} 字元，已傳送前 ${MAX_TEXT_CHARS.toLocaleString()} 字元。）`
    : "";

  const thresholds = parseColumnThresholdsJson(thresholdsJson);
  const userPromptParts = [
    `檔名：${file.name}`,
    `推論類型（依副檔名／MIME）：${kind}（log / csv / unknown 之一）`,
    `檔案大小：${file.size.toLocaleString()} bytes`,
  ];
  if (notes.length > 0) {
    userPromptParts.push("", "## 使用者備註", "", notes);
  }

  if (specMode === "demo") {
    userPromptParts.push(
      "",
      "## 適用之產品規格（Demo）",
      "撰寫「Spec 與符合性」須**引用**下列條款、表格或數值，不得自創上下限。",
      "",
      loadDemoSpecMarkdown(),
    );
  } else if (specMode === "custom" && customSpec.length > 0) {
    userPromptParts.push(
      "",
      "## 適用之產品規格（使用者自訂）",
      "",
      customSpec,
    );
  } else if (specMode === "none") {
    userPromptParts.push(
      "",
      "（本請求未併入產品規格檔；仍須在報告內就資料本身合理檢查，未提供之欄位標「待補」。）",
    );
  }

  if (kind === "csv") {
    userPromptParts.push(
      "",
      "## 系統預先計算之數值摘要（供撰寫依據，勿虛構）",
      "",
      computeCsvNumericSummary(fullText),
    );
    const pre = parseCsvForAnalysis(fullText);
    if (pre.ok) {
      const dev = formatSpecThresholdDeviations(
        pre.data.rows,
        thresholds,
      );
      if (dev.length > 0) {
        userPromptParts.push("", dev);
      }
    }
  }

  const userPrompt = [
    ...userPromptParts,
    "",
    "檔案內文：",
    "```text",
    excerpt + bodyNote,
    "```",
  ].join("\n");

  const google = createGoogleGenerativeAI({ apiKey });
  const modelId = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  try {
    const result = streamText({
      model: google(modelId),
      system: FAE_SYSTEM_PROMPT,
      prompt: userPrompt,
      maxOutputTokens: DEMO_MAX_REPORT_OUTPUT_TOKENS,
      abortSignal: req.signal,
    });
    return result.toTextStreamResponse();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Report stream failed to start";
    return Response.json({ error: message }, { status: 500 });
  }
}
