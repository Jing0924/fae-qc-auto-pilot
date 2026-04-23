"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { TriangleAlert } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CardTitle } from "@/components/ui/card";
import {
  MAX_CSV_ROWS,
  cellIsEmpty,
  filterNonEmptyRows,
  getHeaders,
  isNumericColumn,
  isParseAborted,
  pickXKey,
} from "@/lib/csv/numeric-cols";
import { cn } from "@/lib/utils";

const MAX_NUMERIC_COLS = 8;

type Row = Record<string, string>;
type ChartRow = Record<string, string | number | null>;

type Phase = "parsing" | "ready" | "empty" | "error";

type ParseOutcome =
  | {
      phase: "ready";
      chartData: ChartRow[];
      numericCols: string[];
      omittedCols: number;
      rowTruncated: boolean;
      totalRowsBeforeCap: number;
      xKey: string;
    }
  | { phase: "empty" }
  | { phase: "error"; message: string };

function buildOutcome(results: Papa.ParseResult<Row>): ParseOutcome {
  if (isParseAborted(results)) {
    return { phase: "error", message: "CSV 解析已中止" };
  }

  const rawRows = filterNonEmptyRows(results.data as Row[]);

  if (rawRows.length === 0) {
    if (results.errors.length > 0) {
      return {
        phase: "error",
        message:
          results.errors.map((e) => e.message).join("；") || "CSV 解析失敗",
      };
    }
    return { phase: "empty" };
  }

  const headers = getHeaders(results, rawRows);

  if (headers.length === 0) {
    return { phase: "empty" };
  }

  const totalRowsBeforeCap = rawRows.length;
  const rows = rawRows.slice(0, MAX_CSV_ROWS);
  const rowTruncated = totalRowsBeforeCap > MAX_CSV_ROWS;

  const xKey = pickXKey(headers, rows, isNumericColumn);
  const numericAll = headers.filter(
    (h) => h !== xKey && isNumericColumn(h, rows),
  );
  const omittedCols = Math.max(0, numericAll.length - MAX_NUMERIC_COLS);
  const numericCols = numericAll.slice(0, MAX_NUMERIC_COLS);

  if (numericCols.length === 0) {
    return { phase: "empty" };
  }

  const chartData: ChartRow[] = rows.map((row, i) => {
    const d: ChartRow = {};
    if (xKey === "__idx") {
      d.__idx = i;
    } else {
      const xv = row[xKey];
      d[xKey] = cellIsEmpty(xv) ? "" : String(xv).trim();
    }
    for (const col of numericCols) {
      const raw = row[col];
      d[col] = cellIsEmpty(raw) ? null : Number(String(raw).trim());
    }
    return d;
  });

  return {
    phase: "ready",
    chartData,
    numericCols,
    omittedCols,
    rowTruncated,
    totalRowsBeforeCap,
    xKey,
  };
}

export function CsvChart({ file }: { file: File }) {
  const [phase, setPhase] = useState<Phase>("parsing");
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPhase("parsing");
      setOutcome(null);
    });

    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (results) => {
        if (cancelled) return;
        const next = buildOutcome(results);
        setOutcome(next);
        setPhase(next.phase === "error" ? "error" : next.phase === "empty" ? "empty" : "ready");
      },
      error: (err) => {
        if (cancelled) return;
        setOutcome({
          phase: "error",
          message: err.message || "無法讀取檔案",
        });
        setPhase("error");
      },
    });

    return () => {
      cancelled = true;
    };
  }, [file]);

  const ready = outcome?.phase === "ready" ? outcome : null;

  const xAxisProps = useMemo(() => {
    if (!ready) return {};
    if (ready.xKey === "__idx") {
      return { dataKey: "__idx" as const, type: "number" as const, name: "列" };
    }
    return {
      dataKey: ready.xKey,
      type: "category" as const,
      tick: { fontSize: 11 },
      minTickGap: 20,
      angle: -35,
      textAnchor: "end" as const,
      height: 56,
    };
  }, [ready]);

  if (phase === "parsing") {
    return (
      <p className="text-sm text-muted-foreground">正在解析 CSV…</p>
    );
  }

  if (phase === "error" && outcome?.phase === "error") {
    return (
      <div
        className={cn(
          "flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive",
        )}
        role="alert"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        {outcome.message}
      </div>
    );
  }

  if (phase === "empty" || !ready) {
    return (
      <p className="text-sm text-muted-foreground">
        沒有可繪製的資料（空白檔案或沒有數值欄位）。
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {ready.rowTruncated ? (
        <p className="text-xs text-muted-foreground">
          列數超過 {MAX_CSV_ROWS.toLocaleString()}，已截斷為前 {MAX_CSV_ROWS.toLocaleString()}{" "}
          列以避免瀏覽器卡頓（原始 {ready.totalRowsBeforeCap.toLocaleString()}{" "}
          列）。
        </p>
      ) : null}
      {ready.omittedCols > 0 ? (
        <p className="text-xs text-muted-foreground">
          已省略 {ready.omittedCols} 個數值欄（僅顯示前 {MAX_NUMERIC_COLS}{" "}
          欄）。
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {ready.numericCols.map((col) => (
          <div
            key={col}
            className="flex flex-col gap-2 rounded-lg border border-border/80 bg-muted/10 p-3"
          >
            <CardTitle className="text-sm font-medium leading-snug">
              {col}
            </CardTitle>
            <div className="h-[220px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={ready.chartData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 11 }} width={48} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid color-mix(in oklch, var(--border) 60%, transparent)",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey={col}
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "var(--primary)" }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
