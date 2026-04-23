"use client";

import { useEffect, useState } from "react";
import { computeCsvNumericSummary } from "@/lib/fae/csv-numeric-summary";
import { parseCsvForAnalysis } from "@/lib/fae/parse-csv-for-analysis";

export type FaeCsvPrepStatus = "idle" | "loading" | "ready" | "unavailable";

export type FaeCsvPrepState = {
  status: FaeCsvPrepStatus;
  /** 與 API 併入之數值摘要相同來源 */
  summaryText: string;
  error: string | null;
  /** 簡要狀態說明（如非 CSV） */
  hint: string | null;
};

const initial: FaeCsvPrepState = {
  status: "idle",
  summaryText: "",
  error: null,
  hint: null,
};

/**
 * 以與伺服端相同之 {@link parseCsvForAnalysis} / {@link computeCsvNumericSummary}
 * 在前端產生摘要，供左欄顯示。
 */
export function useFaeCsvPrep(file: File | null): FaeCsvPrepState {
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
            error: pre.error.papaErrorDetail ?? null,
            hint: "已解析；見摘要訊息。",
          });
          return;
        }
        const summaryText = computeCsvNumericSummary(text);
        setState({
          status: "ready",
          summaryText,
          error: null,
          hint: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: "ready",
          summaryText: "",
          error: e instanceof Error ? e.message : "讀取檔案失敗",
          hint: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [file, file?.lastModified, file?.name, file?.size]);

  return state;
}
