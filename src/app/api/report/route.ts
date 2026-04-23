import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { stepCountIs, streamText, tool, zodSchema } from "ai";
import { z } from "zod";
import { inferDataKind } from "@/lib/fae/build-mock-report";
import { computeCsvNumericSummary } from "@/lib/fae/csv-numeric-summary";
import {
  analyzeQcBatchCsv,
  computeComparativeMetrics,
  listQcSampleFiles,
  pickHistoryBasenameWithRoot,
  readSampleCsvIfAllowed,
  summaryToJsonForModel,
  whitelistFromMetas,
} from "@/lib/fae/qc-history-compare";

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

/** 多步 QC 歷史比對 Agent 專用 */
const DEMO_QC_AGENT_MAX_REPORT_CHARS = 10_000;
const DEMO_QC_AGENT_MAX_OUTPUT_TOKENS = 12_288;

const FAE_SYSTEM_PROMPT = [
  "你是資深 FAE（現場應用工程師）兼品管分析顧問。",
  "使用者會上傳測試 log 或品管 CSV 等文字內容（可能已截斷）。",
  "分析時請**先**對照系統所附之「產品規格（Demo 或自訂）」與數值摘要，再談趨勢、離群與改善建議；敘事須以規格與實測的對照為主軸。",
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

const QC_AGENT_SYSTEM_PROMPT = [
  "你是資深 FAE，任務是撰寫「QC 測試批次 vs 歷史 sample」的深度比對報告（繁體中文）。",
  "",
  "【思維鏈 — 必依序執行】",
  "Step 1：呼叫工具 analyzeCurrentBatch，掌握當前檔之 lot 聚合、異常列、stage 分布與檔級平均。",
  "Step 2：根據 Step 1 的結論，呼叫 lookupHistory（currentFileName 必須與 Step 1 之 fileName 一致）；必要時傳 stageFilter（如 FT、CP）。",
  "Step 3：若 lookupHistory 回傳 found: true，**必須**再呼叫 calculateComparativeMetrics（baselineFileName＝歷史檔、currentFileName＝當前檔），取得 IDDQ／Fmax／Yield 之全檔平均與 diffPct。若 found: false，於報告中說明無歷史對照，仍完成當批分析。",
  "Step 4：輸出完整 Markdown 報告（含比對表）；表格與敘述中的 old／new／diffPct **必須與工具輸出完全一致**，不得竄改或四捨五入成不同數字。",
  "",
  `【篇幅】全文（含標題與表格）總字元數不得超過 ${DEMO_QC_AGENT_MAX_REPORT_CHARS}；請預留結尾並優先保留結論與比對表。`,
  "",
  "【章節建議】",
  "## 摘要",
  "## 當前批次分析（含異常列與 lot 觀察）",
  "## 歷史對照與檔案來源",
  "## 指標比對（IDDQ、Fmax、Yield；附表格）",
  "## FAE 判讀與 Next steps",
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

type ResolvedCurrentBatch =
  | { fileName: string; text: string }
  | { error: string };

function resolveQcAgentCurrentBatch(args: {
  projectRoot: string;
  metas: ReturnType<typeof listQcSampleFiles>;
  whitelist: Set<string>;
  upload: { name: string; text: string } | null;
}): ResolvedCurrentBatch {
  const { projectRoot, metas, whitelist, upload } = args;
  if (upload && upload.text.trim().length > 0) {
    return { fileName: upload.name, text: upload.text };
  }
  if (metas.length === 0) {
    return {
      error:
        "沒有上傳有效 CSV 且 public/samples 內找不到 fake-qc-lot*.csv 示範檔。",
    };
  }
  const latest = metas[0]!.basename;
  const r = readSampleCsvIfAllowed(latest, whitelist, projectRoot);
  if (!r.ok) return { error: r.error };
  return { fileName: latest, text: r.text };
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

  const agentMode = getFormString(form, "agentMode") === "qc_compare";
  const fileRaw = form.get("file");
  const file = fileRaw instanceof File ? fileRaw : null;

  if (!agentMode && !file) {
    return Response.json(
      { error: 'Missing "file" field (File)' },
      { status: 400 },
    );
  }

  if (!agentMode && file!.size === 0) {
    return Response.json({ error: "Empty file" }, { status: 400 });
  }

  if (!agentMode && file!.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: `File too large (demo limit ${MAX_FILE_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const notes = getFormString(form, "notes")?.trim() ?? "";
  const specModeRaw = getFormString(form, "specMode");
  const specMode =
    specModeRaw === "none" || specModeRaw === "custom" || specModeRaw === "demo"
      ? specModeRaw
      : "demo";
  const customSpec = getFormString(form, "customSpec")?.trim() ?? "";

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

  const google = createGoogleGenerativeAI({ apiKey });
  const modelId = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  if (agentMode) {
    if (file && file.size > MAX_FILE_BYTES) {
      return Response.json(
        { error: `File too large (demo limit ${MAX_FILE_BYTES} bytes)` },
        { status: 413 },
      );
    }

    let upload: { name: string; text: string } | null = null;
    if (file && file.size > 0) {
      try {
        const fullText = await file.text();
        upload = { name: file.name, text: fullText };
      } catch {
        return Response.json(
          { error: "Could not read file as text" },
          { status: 400 },
        );
      }
    }

    const projectRoot = process.cwd();
    const metas = listQcSampleFiles(projectRoot);
    const whitelist = whitelistFromMetas(metas);
    const currentResolved = resolveQcAgentCurrentBatch({
      projectRoot,
      metas,
      whitelist,
      upload,
    });
    if ("error" in currentResolved) {
      return Response.json({ error: currentResolved.error }, { status: 400 });
    }

    const uploadedCtx =
      upload && upload.text.trim().length > 0 ? upload : null;

    const userPromptParts: string[] = [];
    if (notes.length > 0) {
      userPromptParts.push("## 使用者備註", "", notes, "");
    }
    userPromptParts.push(
      "## 當前批次資料來源（系統）",
      `- 檔名：${currentResolved.fileName}`,
      `- ${uploadedCtx ? "以上傳檔內容作為當前批次。" : "未上傳檔或檔案為空，已使用 public/samples 內最新之 fake-qc-lot*.csv。"}`,
      "",
    );

    if (specMode === "demo") {
      userPromptParts.push(
        "## 適用之產品規格（Demo）",
        "",
        loadDemoSpecMarkdown(),
        "",
      );
    } else if (specMode === "custom" && customSpec.length > 0) {
      userPromptParts.push("## 適用之產品規格（使用者自訂）", "", customSpec, "");
    } else if (specMode === "none") {
      userPromptParts.push(
        "（本請求未併入產品規格檔；仍請合理檢查資料與工具輸出。）",
        "",
      );
    }

    const tools = {
      analyzeCurrentBatch: tool({
        description:
          "解析當前批次 QC CSV（上傳檔或 samples 最新檔），回傳 lot 聚合、異常列、stage 計數與檔級平均（JSON）。",
        inputSchema: zodSchema(z.object({})),
        execute: async () => {
          const r = analyzeQcBatchCsv(
            currentResolved.text,
            currentResolved.fileName,
          );
          if (!r.ok) return JSON.stringify({ error: r.error });
          return summaryToJsonForModel(r.summary);
        },
      }),
      lookupHistory: tool({
        description:
          "在 public/samples 尋找時間早於當前檔之 fake-qc-lot*.csv；currentFileName 須與 analyzeCurrentBatch 之 fileName 一致。可選 stageFilter（FT／CP）。",
        inputSchema: zodSchema(
          z.object({
            currentFileName: z
              .string()
              .describe("與 analyzeCurrentBatch 回傳的 fileName 相同"),
            stageFilter: z
              .string()
              .optional()
              .describe("例如 FT、CP；省略則取時間上緊鄰之上一檔"),
          }),
        ),
        execute: async ({ currentFileName, stageFilter }) => {
          const p = pickHistoryBasenameWithRoot({
            metas,
            currentBasename: currentFileName,
            whitelist,
            projectRoot,
            stageFilter,
          });
          if (!p.found) {
            return JSON.stringify({ found: false, reason: p.reason });
          }
          const text = readSampleCsvIfAllowed(p.basename, whitelist, projectRoot);
          if (!text.ok) {
            return JSON.stringify({ found: false, reason: text.error });
          }
          const an = analyzeQcBatchCsv(text.text, p.basename);
          if (!an.ok) {
            return JSON.stringify({ found: false, reason: an.error });
          }
          return JSON.stringify({
            found: true,
            historyFileName: p.basename,
            summary: an.summary,
          });
        },
      }),
      calculateComparativeMetrics: tool({
        description:
          "比對兩份 CSV 之全檔平均 IDDQ、Fmax、Yield，計算 diffPct（舊為 baseline）。數值須原樣寫入報告。",
        inputSchema: zodSchema(
          z.object({
            baselineFileName: z.string(),
            currentFileName: z.string(),
          }),
        ),
        execute: async ({ baselineFileName, currentFileName }) => {
          const baseRead = readSampleCsvIfAllowed(
            baselineFileName,
            whitelist,
            projectRoot,
          );
          if (!baseRead.ok) {
            return JSON.stringify({ error: baseRead.error });
          }
          let currentText: string;
          if (uploadedCtx && currentFileName === uploadedCtx.name) {
            currentText = uploadedCtx.text;
          } else {
            const cr = readSampleCsvIfAllowed(
              currentFileName,
              whitelist,
              projectRoot,
            );
            if (!cr.ok) return JSON.stringify({ error: cr.error });
            currentText = cr.text;
          }
          const cmp = computeComparativeMetrics({
            baselineText: baseRead.text,
            currentText,
            baselineFileName,
            currentFileName,
          });
          if (!cmp.ok) return JSON.stringify({ error: cmp.error });
          return JSON.stringify(cmp.data);
        },
      }),
    };

    const userPrompt =
      userPromptParts.join("\n") +
      "\n請依系統指示完成工具呼叫並產出 Markdown 報告。";

    try {
      const result = streamText({
        model: google(modelId),
        system: QC_AGENT_SYSTEM_PROMPT,
        prompt: userPrompt,
        tools,
        stopWhen: stepCountIs(5),
        maxOutputTokens: DEMO_QC_AGENT_MAX_OUTPUT_TOKENS,
        abortSignal: req.signal,
        onStepFinish: (step) => {
          if (process.env.NODE_ENV !== "production") {
            const calls = step.toolCalls?.length ?? 0;
            if (calls > 0) {
              console.info(
                "[qc_agent] step tool calls:",
                step.toolCalls?.map((c) => c.toolName),
              );
            }
          }
        },
      });
      return result.toTextStreamResponse();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Report stream failed to start";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // --- 既有單次 prompt 路徑（非 Agent）---
  if (!file) {
    return Response.json(
      { error: 'Missing "file" field (File)' },
      { status: 400 },
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
  }

  const userPrompt = [
    ...userPromptParts,
    "",
    "檔案內文：",
    "```text",
    excerpt + bodyNote,
    "```",
  ].join("\n");

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
