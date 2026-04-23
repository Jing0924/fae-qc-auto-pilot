import type { ParseResult } from "papaparse";

/** 與 {@link CsvChart} 圖表列上限一致，伺服端統計也沿用。 */
export const MAX_CSV_ROWS = 2000;

export type CsvStringRow = Record<string, string>;

export function cellIsEmpty(v: unknown): boolean {
  if (v == null) return true;
  const s = typeof v === "string" ? v : String(v);
  return s.trim() === "";
}

/** 欄內每個非空儲存格若皆可解析為有限數值則為數值欄（邏輯與 CsvChart 一致）。 */
export function isNumericColumn(field: string, rows: CsvStringRow[]): boolean {
  let sawNonEmpty = false;
  for (const row of rows) {
    const raw = row[field];
    if (cellIsEmpty(raw)) continue;
    sawNonEmpty = true;
    const n = Number(String(raw).trim());
    if (Number.isNaN(n) || !Number.isFinite(n)) return false;
  }
  return sawNonEmpty;
}

export function pickXKey(
  headers: string[],
  rows: CsvStringRow[],
  isNumeric: (f: string, r: CsvStringRow[]) => boolean,
): string {
  for (const h of headers) {
    if (!isNumeric(h, rows)) return h;
  }
  return "__idx";
}

/** 從解析結果擷取非全空列；與 CsvChart 的 `buildOutcome` 前面步驟一致。 */
export function filterNonEmptyRows(
  data: CsvStringRow[] | undefined,
): CsvStringRow[] {
  if (!data?.length) return [];
  return data.filter((row) =>
    Object.values(row).some((v) => !cellIsEmpty(v)),
  );
}

export function getHeaders(
  results: ParseResult<CsvStringRow>,
  rawRows: CsvStringRow[],
): string[] {
  return (
    results.meta.fields?.filter(Boolean) ?? (rawRows[0] ? Object.keys(rawRows[0]) : [])
  );
}

export function isParseAborted(results: { meta: { aborted: boolean } }): boolean {
  return results.meta.aborted;
}
