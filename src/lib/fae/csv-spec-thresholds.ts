import type { CsvStringRow } from "@/lib/csv/numeric-cols";
import { cellIsEmpty } from "@/lib/csv/numeric-cols";

/**
 * 欄位之 USL/LSL（可僅定義 min 或 max）。鍵名須與 CSV 欄位名一致。
 */
export type ColumnThresholds = Record<
  string,
  { min?: number; max?: number }
>;

export function parseColumnThresholdsJson(
  json: string | null | undefined,
): ColumnThresholds | null {
  if (json == null || String(json).trim() === "") return null;
  try {
    const o = JSON.parse(String(json)) as unknown;
    if (o == null || typeof o !== "object" || Array.isArray(o)) return null;
    return o as ColumnThresholds;
  } catch {
    return null;
  }
}

const MAX_VIOLATION_LINES = 40;
const MAX_PER_COL = 12;

/**
 * 依欄位上下限掃描列，產生供併入提示之 Markdown。列號 1-based，不含表頭。
 */
export function formatSpecThresholdDeviations(
  rows: CsvStringRow[],
  thresholds: ColumnThresholds | null,
): string {
  if (!thresholds || Object.keys(thresholds).length === 0) {
    return "";
  }
  const entries = Object.entries(thresholds).filter(
    ([, v]) => v && (v.min != null || v.max != null),
  );
  if (entries.length === 0) return "";

  const lines: string[] = [
    "## 參數門檻掃描（與下述規格/數值欄位對照）",
    "",
    "以下列號為資料列 1-based（不含表頭）。",
    "",
  ];

  let lineBudget = MAX_VIOLATION_LINES;

  for (const [col, spec] of entries) {
    if (lineBudget <= 0) break;
    const min = spec.min;
    const max = spec.max;
    const out: { row1: number; v: number }[] = [];
    for (let i = 0; i < rows.length && out.length < MAX_PER_COL; i++) {
      const raw = rows[i]![col];
      if (cellIsEmpty(raw)) continue;
      const n = Number(String(raw).trim());
      if (Number.isNaN(n) || !Number.isFinite(n)) continue;
      const below = min != null && n < min;
      const above = max != null && n > max;
      if (below || above) {
        out.push({ row1: i + 1, v: n });
      }
    }
    const range =
      min != null && max != null
        ? `[${min}, ${max}]`
        : min != null
          ? `≥ ${min}`
          : max != null
            ? `≤ ${max}`
            : "（未定義）";

    if (out.length === 0) {
      lines.push(
        `- **${col}**（容許：${range}）：於已分析列範圍內，無掃到越界數值。`,
        "",
      );
    } else {
      const parts = out.map(
        (o) => `列 ${o.row1} = ${fmt(o.v)}${describeViol(o.v, min, max)}`,
      );
      lines.push(`- **${col}**（容許：${range}）越界：${parts.join("；")}`, "");
    }
    lineBudget -= 2;
  }

  if (lineBudget <= 0) {
    lines.push("> 門檻掃描敘述已截斷（示範上限）。", "");
  }

  return lines.join("\n").trim();
}

function fmt(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e9) return String(x);
  if (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0)) {
    return x.toExponential(3);
  }
  return x.toFixed(4).replace(/\.?0+$/, "") || "0";
}

function describeViol(
  v: number,
  min: number | undefined,
  max: number | undefined,
): string {
  if (min != null && v < min) return "（低於 LSL）";
  if (max != null && v > max) return "（高於 USL）";
  return "";
}
