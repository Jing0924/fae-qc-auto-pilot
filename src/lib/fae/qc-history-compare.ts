import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CsvStringRow } from "@/lib/csv/numeric-cols";
import { parseCsvForAnalysis } from "@/lib/fae/parse-csv-for-analysis";

const QC_SAMPLE_PATTERN = /^fake-qc-lot.*\.csv$/i;

const METRICS = ["iddq_ua", "fmax_mhz", "yield_pct"] as const;
export type QcMetric = (typeof METRICS)[number];

/** 列與同 lot 平均相對偏差超過此比例則標為異常 */
const LOT_REL_DEV_THRESHOLD = 0.22;

export type QcSampleFileMeta = {
  basename: string;
  absPath: string;
  /** 檔名內 YYYYMMDDHHMMSS；無則 0 */
  nameSortKey: number;
  mtimeMs: number;
};

/** 依檔名時間戳（新→舊），再依 mtime */
export function listQcSampleFiles(projectRoot: string): QcSampleFileMeta[] {
  const dir = join(projectRoot, "public", "samples");
  const names = readdirSync(dir).filter((n) => QC_SAMPLE_PATTERN.test(n));
  const metas: QcSampleFileMeta[] = names.map((basename) => {
    const absPath = join(dir, basename);
    const st = statSync(absPath);
    return {
      basename,
      absPath,
      nameSortKey: parseFakeQcLotFilenameSortKey(basename),
      mtimeMs: st.mtimeMs,
    };
  });
  metas.sort((a, b) => {
    if (b.nameSortKey !== a.nameSortKey) return b.nameSortKey - a.nameSortKey;
    return b.mtimeMs - a.mtimeMs;
  });
  return metas;
}

export function whitelistFromMetas(metas: QcSampleFileMeta[]): Set<string> {
  return new Set(metas.map((m) => m.basename));
}

/** fake-qc-lot-2026-04-23-163045.csv → 20260423163045 */
export function parseFakeQcLotFilenameSortKey(basename: string): number {
  const m = basename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{6})\.csv$/i);
  if (!m) return 0;
  const [, y, mo, d, hms] = m;
  return Number(`${y}${mo}${d}${hms}`);
}

export function readSampleCsvIfAllowed(
  basename: string,
  whitelist: Set<string>,
  projectRoot: string,
): { ok: true; text: string } | { ok: false; error: string } {
  if (!whitelist.has(basename)) {
    return { ok: false, error: "檔名不在允許清單內" };
  }
  const p = join(projectRoot, "public", "samples", basename);
  try {
    return { ok: true, text: readFileSync(p, "utf8") };
  } catch {
    return { ok: false, error: "無法讀取檔案" };
  }
}

function parseCellNumber(row: CsvStringRow, col: string): number | null {
  const raw = row[col];
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

export type LotAggregate = {
  lot_id: string;
  n: number;
  iddq_ua_avg: number | null;
  fmax_mhz_avg: number | null;
  yield_pct_avg: number | null;
};

export type QcAnomalyRow = {
  /** 1-based index within parsed（cap 後）列 */
  rowIndex: number;
  lot_id: string;
  field: QcMetric;
  value: number;
  lotAverage: number;
  relDev: number;
  notes?: string;
};

export type BatchAnalysisSummary = {
  fileName: string;
  rowCount: number;
  rowTruncated: boolean;
  stageCounts: Record<string, number>;
  lotAggregates: LotAggregate[];
  anomalies: QcAnomalyRow[];
  fileLevel: FileLevelMetrics;
};

export type FileLevelMetrics = {
  rowCount: number;
  iddq_ua: number | null;
  fmax_mhz: number | null;
  yield_pct: number | null;
};

export function computeFileLevelMetrics(
  rows: CsvStringRow[],
): FileLevelMetrics {
  const n = rows.length;
  const out: FileLevelMetrics = {
    rowCount: n,
    iddq_ua: null,
    fmax_mhz: null,
    yield_pct: null,
  };
  if (n === 0) return out;
  for (const m of METRICS) {
    const vals: number[] = [];
    for (const row of rows) {
      const v = parseCellNumber(row, m);
      if (v != null) vals.push(v);
    }
    if (vals.length > 0) {
      out[m] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }
  return out;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function analyzeQcBatchCsv(
  csvText: string,
  fileName: string,
): { ok: true; summary: BatchAnalysisSummary } | { ok: false; error: string } {
  const parsed = parseCsvForAnalysis(csvText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error.message };
  }
  const { rows, rowTruncated, totalRowsBeforeCap } = parsed.data;
  const fileLevel = computeFileLevelMetrics(rows);

  const stageCounts: Record<string, number> = {};
  const byLot = new Map<string, CsvStringRow[]>();
  rows.forEach((row, i) => {
    const stage = String(row.stage ?? "").trim() || "—";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const lot = String(row.lot_id ?? "").trim() || `__row_${i}`;
    const arr = byLot.get(lot) ?? [];
    arr.push(row);
    byLot.set(lot, arr);
  });

  const lotAggregates: LotAggregate[] = [];
  for (const [lot_id, lotRows] of byLot) {
    const iddq = lotRows
      .map((r) => parseCellNumber(r, "iddq_ua"))
      .filter((v): v is number => v != null);
    const fmax = lotRows
      .map((r) => parseCellNumber(r, "fmax_mhz"))
      .filter((v): v is number => v != null);
    const yld = lotRows
      .map((r) => parseCellNumber(r, "yield_pct"))
      .filter((v): v is number => v != null);
    lotAggregates.push({
      lot_id,
      n: lotRows.length,
      iddq_ua_avg: mean(iddq),
      fmax_mhz_avg: mean(fmax),
      yield_pct_avg: mean(yld),
    });
  }
  lotAggregates.sort((a, b) => a.lot_id.localeCompare(b.lot_id));

  const lotAvgMap = new Map<string, Record<QcMetric, number | null>>();
  for (const agg of lotAggregates) {
    lotAvgMap.set(agg.lot_id, {
      iddq_ua: agg.iddq_ua_avg,
      fmax_mhz: agg.fmax_mhz_avg,
      yield_pct: agg.yield_pct_avg,
    });
  }

  const anomalies: QcAnomalyRow[] = [];
  rows.forEach((row, i) => {
    const lot = String(row.lot_id ?? "").trim() || `__row_${i}`;
    const avgs = lotAvgMap.get(lot);
    if (!avgs) return;
    const lotRowCount = byLot.get(lot)?.length ?? 0;
    if (lotRowCount < 2) return;

    for (const field of METRICS) {
      const v = parseCellNumber(row, field);
      const avg = avgs[field];
      if (v == null || avg == null || avg === 0) continue;
      const rel = Math.abs(v - avg) / Math.abs(avg);
      if (rel >= LOT_REL_DEV_THRESHOLD) {
        anomalies.push({
          rowIndex: i + 1,
          lot_id: lot,
          field,
          value: v,
          lotAverage: avg,
          relDev: rel,
          notes: String(row.notes ?? "").trim() || undefined,
        });
      }
    }
  });

  return {
    ok: true,
    summary: {
      fileName,
      rowCount: totalRowsBeforeCap,
      rowTruncated,
      stageCounts,
      lotAggregates,
      anomalies,
      fileLevel,
    },
  };
}

export function fileHasStage(csvText: string, stage: string): boolean {
  const want = stage.trim();
  if (!want) return true;
  const parsed = parseCsvForAnalysis(csvText);
  if (!parsed.ok) return false;
  return parsed.data.rows.some(
    (r) => String(r.stage ?? "").trim().toUpperCase() === want.toUpperCase(),
  );
}

/**
 * metas：新→舊。current 在清單內則取下一檔；上傳檔（不在清單）則從 index 0 起找（最新 sample 作為歷史對照起點）。
 */
export function pickHistoryBasenameWithRoot(args: {
  metas: QcSampleFileMeta[];
  currentBasename: string;
  whitelist: Set<string>;
  projectRoot: string;
  stageFilter?: string;
}):
  | { found: true; basename: string }
  | { found: false; reason: string } {
  const { metas, currentBasename, whitelist, projectRoot, stageFilter } = args;
  if (metas.length === 0) {
    return { found: false, reason: "沒有可用之 sample CSV" };
  }

  const inList = whitelist.has(currentBasename);
  const startIdx = inList
    ? metas.findIndex((m) => m.basename === currentBasename) + 1
    : 0;

  if (startIdx >= metas.length) {
    return { found: false, reason: "沒有更早的 sample 檔可對照" };
  }

  for (let i = startIdx; i < metas.length; i++) {
    const cand = metas[i]!.basename;
    if (!stageFilter?.trim()) {
      return { found: true, basename: cand };
    }
    const read = readSampleCsvIfAllowed(cand, whitelist, projectRoot);
    if (!read.ok) continue;
    if (fileHasStage(read.text, stageFilter)) {
      return { found: true, basename: cand };
    }
  }

  return { found: false, reason: "無符合 stage 篩選之較早檔案" };
}

export type ComparativeMetric = {
  old: number | null;
  new: number | null;
  diffPct: number | "N/A";
};

export type ComparativeMetricsResult = {
  baselineFileName: string;
  currentFileName: string;
  iddq_ua: ComparativeMetric;
  fmax_mhz: ComparativeMetric;
  yield_pct: ComparativeMetric;
};

export function pctDiff(oldVal: number, newVal: number): number | "N/A" {
  if (oldVal === 0) return "N/A";
  return ((newVal - oldVal) / oldVal) * 100;
}

export function computeComparativeMetrics(args: {
  baselineText: string;
  currentText: string;
  baselineFileName: string;
  currentFileName: string;
}):
  | { ok: true; data: ComparativeMetricsResult }
  | { ok: false; error: string } {
  const a = analyzeQcBatchCsv(args.baselineText, args.baselineFileName);
  const b = analyzeQcBatchCsv(args.currentText, args.currentFileName);
  if (!a.ok) return { ok: false, error: `baseline: ${a.error}` };
  if (!b.ok) return { ok: false, error: `current: ${b.error}` };

  const o = a.summary.fileLevel;
  const n = b.summary.fileLevel;
  const build = (
    oldV: number | null,
    newV: number | null,
  ): ComparativeMetric => ({
    old: oldV,
    new: newV,
    diffPct:
      oldV != null && newV != null ? pctDiff(oldV, newV) : ("N/A" as const),
  });

  return {
    ok: true,
    data: {
      baselineFileName: args.baselineFileName,
      currentFileName: args.currentFileName,
      iddq_ua: build(o.iddq_ua, n.iddq_ua),
      fmax_mhz: build(o.fmax_mhz, n.fmax_mhz),
      yield_pct: build(o.yield_pct, n.yield_pct),
    },
  };
}

export function summaryToJsonForModel(summary: BatchAnalysisSummary): string {
  return JSON.stringify(summary, null, 2);
}
