"use client";

import { useEffect, useState } from "react";
import { computeCsvNumericSummary } from "@/lib/fae/csv-numeric-summary";
import { DEMO_DEFAULT_THRESHOLDS } from "@/lib/fae/demo-spec";
import { parseCsvForAnalysis } from "@/lib/fae/parse-csv-for-analysis";
import {
  formatSpecThresholdDeviations,
  parseColumnThresholdsJson,
} from "@/lib/fae/csv-spec-thresholds";

export type FaeCsvPrepStatus = "idle" | "loading" | "ready" | "unavailable";

export type FaeCsvPrepState = {
  status: FaeCsvPrepStatus;
  /** 與 API 併入之數值摘要相同來源 */
  summaryText: string;
  /** 門檻掃描敘事（可為空字串） */
  thresholdHints: string;
  error: string | null;
  /** 簡要狀態說明（如非 CSV） */
  hint: string | null;
};

const initial: FaeCsvPrepState = {
  status: "idle",
  summaryText: "",
  thresholdHints: "",
  error: null,
  hint: null,
};

/**
 * 以與伺服端相同之 {@link parseCsvForAnalysis} / {@link computeCsvNumericSummary}
 * 在前端產生摘要與門檻提示，供左欄顯示。
 */
export function useFaeCsvPrep(
  file: File | null,
  thresholdsJson: string,
): FaeCsvPrepState {
  const [state, setState] = useState<FaeCsvPrepState>(initial);

  useEffect(() => {
    let cancelled = false;
    if (!file || !/\.csv$/i.test(file.name)) {
      queueMicrotask(() => {
        if (cancelled) return;
        setState({
          ...initial,
          status: "unavailable",
          hint: file
            ? "此檔非 CSV，不顯示數值預處理摘要。"
            : "請匯入 CSV 以顯示與 API 相同規則之預處理摘要。",
        });
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        status: "loading",
        error: null,
        hint: null,
      }));
    });

    void file
      .text()
      .then((text) => {
        if (cancelled) return;
        const pre = parseCsvForAnalysis(text);
        if (!pre.ok) {
          setState({
            status: "ready",
            summaryText: pre.error.message,
            thresholdHints: "",
            error: pre.error.papaErrorDetail ?? null,
            hint: "已解析；見摘要訊息。",
          });
          return;
        }
        const summaryText = computeCsvNumericSummary(text);
        const t =
          parseColumnThresholdsJson(thresholdsJson) ?? DEMO_DEFAULT_THRESHOLDS;
        const thresholdHints = formatSpecThresholdDeviations(
          pre.data.rows,
          t,
        );
        setState({
          status: "ready",
          summaryText,
          thresholdHints,
          error: null,
          hint: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: "ready",
          summaryText: "",
          thresholdHints: "",
          error: e instanceof Error ? e.message : "讀取檔案失敗",
          hint: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [file, thresholdsJson, file?.lastModified, file?.name, file?.size]);

  return state;
}
