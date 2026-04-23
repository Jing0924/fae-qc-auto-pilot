import Papa from "papaparse";
import {
  MAX_CSV_ROWS,
  type CsvStringRow,
  filterNonEmptyRows,
  getHeaders,
  isNumericColumn,
  isParseAborted,
} from "@/lib/csv/numeric-cols";

export type CsvParseForAnalysisErrorKind =
  | "empty"
  | "aborted"
  | "no_rows"
  | "no_headers"
  | "no_numeric"
  | "parse_error";

export type CsvParseForAnalysisError = {
  kind: CsvParseForAnalysisErrorKind;
  message: string;
  /** 若為 parse 錯誤，Papa 訊息 */
  papaErrorDetail?: string;
};

export type CsvParseForAnalysisData = {
  /** 已 cap 的列，供統計與分析 */
  rows: CsvStringRow[];
  headers: string[];
  rowTruncated: boolean;
  totalRowsBeforeCap: number;
  numericFields: string[];
};

export type CsvParseForAnalysisResult =
  | { ok: false; error: CsvParseForAnalysisError }
  | { ok: true; data: CsvParseForAnalysisData };

/**
 * 與 {@link computeCsvNumericSummary}、伺服端行為一致之 CSV 解析與數值欄判斷。
 * 前後端／Hook 應只透過本函式取得結構，避免兩套規則。
 */
export function parseCsvForAnalysis(
  csvText: string,
): CsvParseForAnalysisResult {
  if (!csvText.trim()) {
    return {
      ok: false,
      error: { kind: "empty", message: "（系統：無內文可分析數值。）" },
    };
  }

  const parsed = Papa.parse<CsvStringRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (isParseAborted(parsed)) {
    return {
      ok: false,
      error: {
        kind: "aborted",
        message: "（系統：CSV 解析中止，無法產生數值統計。）",
      },
    };
  }

  const rawRows = filterNonEmptyRows(parsed.data);
  if (rawRows.length === 0) {
    const errMsg = parsed.errors.map((e) => e.message).join("；");
    if (errMsg) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: `（系統：CSV 解析失敗，無法產生數值統計。${errMsg}）`,
          papaErrorDetail: errMsg,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "no_rows",
        message: "（系統：檔內沒有非空列，無法產生數值統計。）",
      },
    };
  }

  const totalRowsBeforeCap = rawRows.length;
  const rows = rawRows.slice(0, MAX_CSV_ROWS);
  const rowTruncated = totalRowsBeforeCap > MAX_CSV_ROWS;

  const headers = getHeaders(parsed, rawRows);
  if (headers.length === 0) {
    return {
      ok: false,
      error: {
        kind: "no_headers",
        message: "（系統：沒有欄位標題，無法產生數值統計。）",
      },
    };
  }

  const numericFields = headers.filter((h) => isNumericColumn(h, rows));
  if (numericFields.length === 0) {
    return {
      ok: false,
      error: {
        kind: "no_numeric",
        message:
          "（系統：沒有符合條件之數值欄［每欄非空格皆需為可解析之數］，無法產生數值統計。）",
      },
    };
  }

  return {
    ok: true,
    data: {
      rows,
      headers,
      rowTruncated,
      totalRowsBeforeCap,
      numericFields,
    },
  };
}
