import Papa from "papaparse";
import {
  MAX_CSV_ROWS,
  type CsvStringRow,
  cellIsEmpty,
  filterNonEmptyRows,
  getHeaders,
  isNumericColumn,
  isParseAborted,
} from "@/lib/csv/numeric-cols";

const OUTLIERS_PER_COL = 10;
const OUTLIERS_GRAND = 30;

function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo]! * (1 - t) + sorted[hi]! * t;
}

function welford(values: number[]): { mean: number; stdev: number } {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (const x of values) {
    n++;
    const delta = x - mean;
    mean += delta / n;
    const delta2 = x - mean;
    m2 += delta * delta2;
  }
  if (n < 2) return { mean, stdev: 0 };
  return { mean, stdev: Math.sqrt(m2 / (n - 1)) };
}

function medianSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function fmtNum(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e9) return String(x);
  if (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0)) {
    return x.toExponential(4);
  }
  return x.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * 在完整 CSV 字串上計算可重現的數值摘要與 IQR 離群列（列數上限同 {@link MAX_CSV_ROWS}）。
 * 若無法解析或無任何數值欄，回傳說明字串，供併入 LLM 提示，勿回传 null 以免漏敘述。
 */
export function computeCsvNumericSummary(csvText: string): string {
  if (!csvText.trim()) {
    return "（系統：無內文可分析數值。）";
  }

  const parsed = Papa.parse<CsvStringRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (isParseAborted(parsed)) {
    return "（系統：CSV 解析中止，無法產生數值統計。）";
  }

  const rawRows = filterNonEmptyRows(parsed.data);
  if (rawRows.length === 0) {
    const errMsg = parsed.errors.map((e) => e.message).join("；");
    if (errMsg) {
      return `（系統：CSV 解析失敗，無法產生數值統計。${errMsg}）`;
    }
    return "（系統：檔內沒有非空列，無法產生數值統計。）";
  }

  const totalRowsBeforeCap = rawRows.length;
  const rows = rawRows.slice(0, MAX_CSV_ROWS);
  const rowTruncated = totalRowsBeforeCap > MAX_CSV_ROWS;

  const headers = getHeaders(parsed, rawRows);
  if (headers.length === 0) {
    return "（系統：沒有欄位標題，無法產生數值統計。）";
  }

  const numericFields = headers.filter((h) => isNumericColumn(h, rows));
  if (numericFields.length === 0) {
    return "（系統：沒有符合條件之數值欄［每欄非空格皆需為可解析之數］，無法產生數值統計。）";
  }

  const lines: string[] = [];
  if (rowTruncated) {
    lines.push(
      `> 列數已超過 ${MAX_CSV_ROWS.toLocaleString()}，僅就前 ${MAX_CSV_ROWS.toLocaleString()} 列計算（原始 ${totalRowsBeforeCap.toLocaleString()} 列）。`,
    );
  }

  lines.push("### 各數值欄彙總", "");
  lines.push(
    "| 欄位 | n | min | max | 平均 | 樣本標準差 | 中位數 |",
    "| --- | --: | --: | --: | --: | --: | --: |",
  );

  for (const field of numericFields) {
    const values: number[] = [];
    for (const row of rows) {
      const raw = row[field];
      if (cellIsEmpty(raw)) continue;
      values.push(Number(String(raw).trim()));
    }
    const sorted = [...values].sort((a, b) => a - b);
    const { mean, stdev } = welford(values);
    const med = medianSorted(sorted);
    lines.push(
      `| ${field} | ${values.length} | ${fmtNum(sorted[0]!)} | ${fmtNum(sorted[sorted.length - 1]!)} | ${fmtNum(mean)} | ${fmtNum(stdev)} | ${fmtNum(med)} |`,
    );
  }

  lines.push("", "### IQR 離群（Tukey 1.5×IQR；列號為資料列 1-based，不含表頭）", "");

  let outlierTotalListed = 0;
  for (const field of numericFields) {
    if (outlierTotalListed >= OUTLIERS_GRAND) {
      lines.push(
        "",
        `> 離群條目已達全檔合計上限（${OUTLIERS_GRAND} 筆），其餘欄位略。`,
      );
      break;
    }

    const nonEmpty: number[] = [];
    for (const row of rows) {
      const raw = row[field];
      if (cellIsEmpty(raw)) continue;
      nonEmpty.push(Number(String(raw).trim()));
    }
    if (nonEmpty.length < 4) {
      lines.push(
        `- **${field}**：非空筆數小於 4，略過 IQR 離群標示。`,
      );
      continue;
    }
    const s = [...nonEmpty].sort((a, b) => a - b);
    const q1 = quantileSorted(s, 0.25);
    const q3 = quantileSorted(s, 0.75);
    const iqr = q3 - q1;
    if (iqr === 0) {
      lines.push(
        `- **${field}**：Q1=Q3，IQR=0，不標 IQR 離群。`,
      );
      continue;
    }
    const low = q1 - 1.5 * iqr;
    const high = q3 + 1.5 * iqr;
    const colOut: { row1: number; value: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]![field];
      if (cellIsEmpty(raw)) continue;
      const v = Number(String(raw).trim());
      if (v < low || v > high) {
        colOut.push({ row1: i + 1, value: v });
        if (colOut.length >= OUTLIERS_PER_COL) break;
      }
    }
    const room = OUTLIERS_GRAND - outlierTotalListed;
    const toShow = colOut.slice(0, Math.min(OUTLIERS_PER_COL, room));
    outlierTotalListed += toShow.length;

    if (toShow.length === 0) {
      lines.push(
        `- **${field}**（Q1=${fmtNum(q1)}, Q3=${fmtNum(q3)}, IQR=${fmtNum(iqr)}）：柵內，無樣本列點。`,
      );
    } else {
      const parts = toShow.map((o) => `列 ${o.row1} = ${fmtNum(o.value)}`);
      const hadMore = colOut.length > toShow.length;
      lines.push(
        `- **${field}**（柵下界 ${fmtNum(low)}、上界 ${fmtNum(high)}）：${parts.join("；")}${
          hadMore ? "（同欄另有離群，已因每欄上限略）" : ""
        }`,
      );
    }
  }

  return lines.join("\n");
}
