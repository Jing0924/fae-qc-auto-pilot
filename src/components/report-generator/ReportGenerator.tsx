"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Loader2,
  Printer,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CsvChart } from "@/components/csv-chart";
import { useFaeCsvPrep } from "@/hooks/use-fae-csv-prep";
import { buildReportDownloadFilename } from "@/lib/fae/report-filename";
import {
  buildZipDownloadBasename,
  downloadReportsZip,
} from "@/lib/fae/zip-reports";
import { cn } from "@/lib/utils";
import { FaeMarkdown } from "./FaeMarkdown";

type ItemStatus = "idle" | "queued" | "streaming" | "done" | "error";

type ReportItem = {
  id: string;
  file: File;
  status: ItemStatus;
  markdown: string;
  error?: string;
};

type SpecMode = "demo" | "none" | "custom";

export type ReportStreamContext = {
  notes: string;
  specMode: SpecMode;
  customSpec: string;
  /** 多步 QC 歷史比對（Gemini 工具循環） */
  qcAgentMode: boolean;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function itemStateBadge(item: ReportItem) {
  switch (item.status) {
    case "queued":
      return <Badge variant="secondary">佇列中</Badge>;
    case "streaming":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          串流中
        </Badge>
      );
    case "done":
      return <Badge variant="default">完成</Badge>;
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <TriangleAlert className="size-3" />
          錯誤
        </Badge>
      );
    default:
      return <Badge variant="outline">待機</Badge>;
  }
}

function aggregateBadge(items: ReportItem[]) {
  const n = items.length;
  if (n === 0) {
    return <Badge variant="outline">無檔案</Badge>;
  }
  const done = items.filter((i) => i.status === "done").length;
  const err = items.filter((i) => i.status === "error").length;
  const streaming = items.some(
    (i) => i.status === "streaming" || i.status === "queued",
  );
  if (streaming) {
    return <Badge variant="secondary">{`進行中 · ${done}/${n} 完成`}</Badge>;
  }
  if (err > 0) {
    return (
      <Badge variant="destructive" className="gap-1">
        {`${done} 份完成`}、{err} 份錯誤
      </Badge>
    );
  }
  if (done === n && n > 0) {
    return <Badge variant="default">{`${done} 份完成`}</Badge>;
  }
  if (done > 0) {
    return <Badge variant="default">{`${done} 份完成`}</Badge>;
  }
  return <Badge variant="outline">待產生</Badge>;
}

async function streamReportForFile(
  file: File | null,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  ctx: ReportStreamContext,
): Promise<void> {
  const body = new FormData();
  if (file && file.size > 0) {
    body.set("file", file);
  }
  body.set("notes", ctx.notes);
  body.set("specMode", ctx.specMode);
  body.set("customSpec", ctx.customSpec);
  if (ctx.qcAgentMode) {
    body.set("agentMode", "qc_compare");
  }
  const res = await fetch("/api/report", {
    method: "POST",
    body,
    signal,
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    const msg =
      errJson && typeof errJson.error === "string"
        ? errJson.error
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  if (!res.body) {
    throw new Error("No response body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += decoder.decode(value, { stream: true });
    onDelta(accumulated);
  }
}

const PREVIEW_SKELETON_MAX = 72;

export function ReportGenerator() {
  const [items, setItems] = useState<ReportItem[]>([]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [csvViewId, setCsvViewId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [specMode, setSpecMode] = useState<SpecMode>("demo");
  const [customSpec, setCustomSpec] = useState("");
  const [notes, setNotes] = useState("");
  const [qcAgentMode, setQcAgentMode] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const csvItems = useMemo(
    () => items.filter((i) => /\.csv$/i.test(i.file.name)),
    [items],
  );

  const csvTabValue = useMemo(() => {
    if (csvItems.length === 0) return null;
    if (csvViewId && csvItems.some((c) => c.id === csvViewId)) {
      return csvViewId;
    }
    return csvItems[0]!.id;
  }, [csvItems, csvViewId]);

  const activeCsvFile = useMemo(() => {
    if (!csvTabValue) return null;
    return csvItems.find((c) => c.id === csvTabValue)?.file ?? null;
  }, [csvItems, csvTabValue]);

  const csvPrep = useFaeCsvPrep(activeCsvFile);

  const resetStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const list = Array.from(fileList).filter((f) => f.size > 0);
    if (list.length === 0) return;
    const toAdd: ReportItem[] = list.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "idle" as const,
      markdown: "",
    }));
    const firstCsv = toAdd.find((x) => /\.csv$/i.test(x.file.name));
    if (firstCsv) setCsvViewId(firstCsv.id);
    setItems((prev) => [...prev, ...toAdd]);
    setGlobalError(null);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
    setOpenItemId((o) => (o === id ? null : o));
  }, []);

  const clearAll = useCallback(() => {
    resetStream();
    setItems([]);
    setOpenItemId(null);
    setCsvViewId(null);
    setGlobalError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [resetStream]);

  const isBatchBusy = items.some(
    (i) => i.status === "streaming" || i.status === "queued",
  );

  const qcAgentBlockedByFileType = useMemo(
    () => items.some((i) => !/\.csv$/i.test(i.file.name)),
    [items],
  );

  useEffect(() => {
    if (qcAgentBlockedByFileType && qcAgentMode) {
      setQcAgentMode(false);
    }
  }, [qcAgentBlockedByFileType, qcAgentMode]);

  const toggleItem = useCallback((id: string) => {
    setOpenItemId((o) => {
      const next = o === id ? null : id;
      if (next) {
        const it = items.find((x) => x.id === next);
        if (it && /\.csv$/i.test(it.file.name)) {
          setCsvViewId(next);
        }
      }
      return next;
    });
  }, [items]);

  const downloadOne = useCallback((item: ReportItem) => {
    if (item.markdown.trim().length === 0) return;
    const blob = new Blob([item.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildReportDownloadFilename(item.file);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const downloadAllZip = useCallback(async () => {
    const doneWithBody = items.filter(
      (i) => i.status === "done" && i.markdown.trim().length > 0,
    );
    if (doneWithBody.length === 0) return;
    await downloadReportsZip(
      doneWithBody.map((i) => ({
        filename: buildReportDownloadFilename(i.file),
        content: i.markdown,
      })),
      buildZipDownloadBasename(),
    );
  }, [items]);

  const printReport = useCallback(() => {
    window.print();
  }, []);

  const generateReports = useCallback(async () => {
    if (items.length === 0 && !qcAgentMode) {
      setGlobalError("請先加入至少一個檔案，或勾選「多步歷史比對 Agent」以使用示範 CSV。");
      return;
    }
    if (isBatchBusy) return;
    if (specMode === "custom" && customSpec.trim().length === 0) {
      setGlobalError("已選擇「自訂規格」時，請在文字框內貼上規格內容，或改選 Demo/不併入。");
      return;
    }

    const ctx: ReportStreamContext = {
      notes: notes.trim(),
      specMode,
      customSpec: customSpec.trim(),
      qcAgentMode,
    };
    setGlobalError(null);
    resetStream();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    let snapshot = items;
    if (items.length === 0 && qcAgentMode) {
      const ghostId = crypto.randomUUID();
      const placeholder = new File(
        [],
        "（示範：public/samples 最新 fake-qc-lot）.csv",
        { type: "text/csv" },
      );
      snapshot = [
        {
          id: ghostId,
          file: placeholder,
          status: "idle" as const,
          markdown: "",
        },
      ];
      setItems(snapshot);
      setOpenItemId(ghostId);
    }

    try {
      for (let i = 0; i < snapshot.length; i++) {
        const { id, file } = snapshot[i]!;
        setOpenItemId(id);
        setItems((prev) =>
          prev.map((x) => {
            const idx = snapshot.findIndex((s) => s.id === x.id);
            if (idx === -1) return x;
            if (idx < i) return x;
            if (idx === i) {
              return {
                ...x,
                status: "streaming" as const,
                markdown: "",
                error: undefined,
              };
            }
            return { ...x, status: "queued" as const };
          }),
        );

        const payload: File | null =
          qcAgentMode && file.size === 0 ? null : file;

        try {
          await streamReportForFile(payload, signal, (text) => {
            setItems((prev) =>
              prev.map((x) => (x.id === id ? { ...x, markdown: text } : x)),
            );
          }, ctx);
          setItems((prev) =>
            prev.map((x) => (x.id === id ? { ...x, status: "done" } : x)),
          );
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            setItems((prev) =>
              prev.map((x) => {
                const idx = snapshot.findIndex((s) => s.id === x.id);
                if (x.id === id) {
                  return { ...x, status: "error" as const, error: "已取消" };
                }
                if (idx !== -1 && idx > i) {
                  return { ...x, status: "idle" as const };
                }
                return x;
              }),
            );
            return;
          }
          const msg = e instanceof Error ? e.message : "Unknown error";
          setItems((prev) =>
            prev.map((x) =>
              x.id === id ? { ...x, status: "error" as const, error: msg } : x,
            ),
          );
        }
      }
    } finally {
      abortRef.current = null;
    }
  }, [
    customSpec,
    isBatchBusy,
    items,
    notes,
    qcAgentMode,
    resetStream,
    specMode,
  ]);

  const cancelBatch = useCallback(() => {
    resetStream();
  }, [resetStream]);

  const hasZipEligible = items.some(
    (i) => i.status === "done" && i.markdown.trim().length > 0,
  );

  const printItem = useMemo(() => {
    if (openItemId) {
      const o = items.find((x) => x.id === openItemId);
      if (o && o.markdown.trim().length > 0) return o;
    }
    return items.find((x) => x.status === "done" && x.markdown.trim().length > 0) ?? null;
  }, [items, openItemId]);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="no-print space-y-6">
          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileUp className="size-5 opacity-80" />
                資料匯入
              </CardTitle>
              <CardDescription>
                可選多份 Log 或 CSV；每份檔案會分別產生一份報告；格式與大小仍受 Demo 限制。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={cn(
                  "flex min-h-[160px] w-full min-w-0 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
                  isDragging
                    ? "border-primary bg-accent/40"
                    : items.length
                      ? "border-primary/40 bg-muted/30 hover:border-primary/50"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30",
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files?.length) {
                    addFiles(e.dataTransfer.files);
                  }
                }}
                onClick={() => fileInputRef.current?.click()}
                role="presentation"
              >
                <input
                  id="fae-file-input"
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept=".log,.txt,.csv,text/plain,text/csv"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                  }}
                />
                <Sparkles className="mb-2 size-8 text-muted-foreground" />
                <p className="text-sm font-medium">拖放檔案至此，或點擊多選</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  可重複加入；下方列表可單筆或一次清除
                </p>
              </div>

              {items.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      已選 {items.length} 個檔案
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={isBatchBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearAll();
                      }}
                    >
                      全部清除
                    </Button>
                  </div>
                  <div className="max-h-40 min-h-0 overflow-y-auto overflow-x-hidden rounded-lg border border-border/80 bg-muted/15 pr-1">
                    <ul className="divide-y divide-border/60 p-1">
                      {items.map((item) => (
                        <li
                          key={item.id}
                          className="flex min-w-0 items-center gap-2 py-1.5 pr-1 pl-2"
                        >
                          <FileText
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate text-xs font-medium text-foreground"
                              title={item.file.name}
                            >
                              {item.file.name}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {formatFileSize(item.file.size)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0"
                            disabled={isBatchBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeItem(item.id);
                            }}
                            aria-label={`移除 ${item.file.name}`}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 rounded border-input"
                    checked={qcAgentMode}
                    onChange={(e) => setQcAgentMode(e.target.checked)}
                    disabled={isBatchBusy || qcAgentBlockedByFileType}
                  />
                  <span>
                    <span className="font-medium">多步歷史比對 Agent</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      啟用後由 Gemini 依序呼叫分析／歷史查詢／指標差異工具；可不匯入檔案，改以
                      public/samples 最新 fake-qc-lot*.csv 為當前批次。
                    </span>
                    {qcAgentBlockedByFileType ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        佇列含非 CSV 時無法使用（多步工具僅支援 QC CSV）。
                      </span>
                    ) : null}
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={generateReports}
                  disabled={(items.length === 0 && !qcAgentMode) || isBatchBusy}
                  className="gap-2"
                >
                  {isBatchBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  產生報告（Gemini 串流）
                </Button>
                {isBatchBusy ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={cancelBatch}
                  >
                    取消
                  </Button>
                ) : null}
              </div>

              {globalError ? (
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  {globalError}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">分析參數與規格</CardTitle>
              <CardDescription>
                併入生成提示：Demo 或自訂規格與備註。CSV
                時左欄顯示與 API 相同之數值預處理摘要（目前圖表對應檔如下）。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fae-spec-mode">產品規格來源</Label>
                <select
                  id="fae-spec-mode"
                  className={cn(
                    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none",
                    "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  )}
                  value={specMode}
                  onChange={(e) => setSpecMode(e.target.value as SpecMode)}
                  disabled={isBatchBusy}
                >
                  <option value="demo">示範規格（demo-product-spec-zh.md）</option>
                  <option value="none">不併入規格檔</option>
                  <option value="custom">自訂（下方貼上全文）</option>
                </select>
              </div>

              {specMode === "custom" ? (
                <div className="space-y-2">
                  <Label htmlFor="fae-custom-spec">自訂規格內文</Label>
                  <Textarea
                    id="fae-custom-spec"
                    className="min-h-[100px] font-mono text-xs"
                    placeholder="貼上 USL/LSL、欄位名、測程關鍵字…"
                    value={customSpec}
                    onChange={(e) => setCustomSpec(e.target.value)}
                    disabled={isBatchBusy}
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="fae-notes">額外備註（併入提示）</Label>
                <Textarea
                  id="fae-notes"
                  className="min-h-[64px] text-sm"
                  placeholder="例如：客戶代號、測條代碼、需特別關注的欄位…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={isBatchBusy}
                />
              </div>

              <div className="rounded-lg border border-border/80 bg-muted/20 p-3">
                <p className="text-xs font-medium text-foreground">
                  數值預處理（選取中 CSV：{activeCsvFile?.name ?? "—"}）
                </p>
                {csvPrep.status === "loading" ? (
                  <div className="mt-2 space-y-2">
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ) : null}
                {csvPrep.status === "unavailable" && csvPrep.hint ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {csvPrep.hint}
                  </p>
                ) : null}
                {csvPrep.status === "ready" && csvPrep.summaryText ? (
                  <div className="mt-2 max-h-48 overflow-y-auto pr-1">
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {csvPrep.summaryText.slice(0, 4000)}
                      {csvPrep.summaryText.length > 4000 ? "…" : ""}
                    </pre>
                  </div>
                ) : null}
                {csvPrep.error ? (
                  <p className="mt-1 text-xs text-destructive">{csvPrep.error}</p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-border/80 shadow-sm">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-lg">報告預覽</CardTitle>
              <CardDescription>依檔收合；串流中會自動展開目前項目</CardDescription>
            </div>
            <div className="no-print flex flex-wrap items-center gap-2">
              {aggregateBadge(items)}
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "gap-1",
                  )}
                  disabled={!hasZipEligible && !printItem}
                >
                  匯出
                  <ChevronDown className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    className="gap-2"
                    disabled={!hasZipEligible}
                    onClick={() => void downloadAllZip()}
                  >
                    <Archive className="size-4" />
                    全部報告 .zip
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-2"
                    disabled={!printItem}
                    onClick={() => printReport()}
                  >
                    <Printer className="size-4" />
                    列印／存 PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {items.length === 0 ? (
              <div className="px-4 pb-4">
                <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                  匯入檔案後，每份報告會出現在此；點擊列可展開 Markdown 預覽。
                </p>
              </div>
            ) : (
              <ul className="max-h-[min(560px,calc(100vh-12rem))] space-y-2 overflow-y-auto overflow-x-hidden px-4 pb-4">
                {items.map((item) => {
                  const isOpen = openItemId === item.id;
                  const canDownload =
                    item.status === "done" && item.markdown.trim().length > 0;
                  const hasPreview =
                    item.markdown.length > 0 || item.status === "streaming";
                  const showSkeleton =
                    item.status === "streaming" &&
                    item.markdown.length < PREVIEW_SKELETON_MAX;
                  return (
                    <li
                      key={item.id}
                      className="overflow-hidden rounded-lg border border-border/80 bg-card"
                    >
                      <div className="no-print flex min-w-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleItem(item.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              "size-4 shrink-0 text-muted-foreground transition-transform",
                              isOpen && "rotate-90",
                            )}
                            aria-hidden
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-sm font-medium"
                            title={item.file.name}
                          >
                            {item.file.name}
                          </span>
                        </button>
                        {itemStateBadge(item)}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={!canDownload}
                          onClick={() => downloadOne(item)}
                        >
                          .md
                        </Button>
                      </div>
                      {isOpen ? (
                        <div className="fae-markdown-panel">
                          {item.error ? (
                            <p className="no-print flex items-start gap-2 px-3 py-2 text-sm text-destructive">
                              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                              {item.error}
                            </p>
                          ) : null}
                          <div className="max-h-80 min-h-0 overflow-y-auto overflow-x-hidden pr-1 print:max-h-none">
                            <div className="p-3 text-sm leading-relaxed">
                              {showSkeleton ? (
                                <div className="no-print mb-3 space-y-2">
                                  <Skeleton className="h-3 w-2/3" />
                                  <Skeleton className="h-3 w-full" />
                                  <Skeleton className="h-3 w-5/6" />
                                  <Skeleton className="h-3 w-1/2" />
                                </div>
                              ) : null}
                              {!hasPreview && item.status !== "error" ? (
                                <p className="text-muted-foreground">尚無內容</p>
                              ) : hasPreview ? (
                                <FaeMarkdown>{item.markdown}</FaeMarkdown>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {csvItems.length > 0 ? (
        <div className="no-print space-y-2">
          <h3 className="text-sm font-medium text-foreground">CSV 視覺化</h3>
          <Tabs
            value={csvTabValue ?? csvItems[0]!.id}
            onValueChange={setCsvViewId}
            className="w-full"
          >
            <TabsList
              className="no-scrollbar h-auto w-full min-w-0 max-w-full flex-wrap justify-start gap-1 p-1"
            >
              {csvItems.map((c) => (
                <TabsTrigger key={c.id} value={c.id} className="max-w-[10rem] shrink truncate text-xs" title={c.file.name}>
                  {c.file.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {csvItems.map((c) => (
              <TabsContent
                key={c.id}
                value={c.id}
                className="mt-3 outline-none"
              >
                <Card className="border-border/80 shadow-sm">
                  <CardHeader className="py-3">
                    <CardTitle className="text-base">圖表</CardTitle>
                    <CardDescription className="truncate" title={c.file.name}>
                      {c.file.name}（純前端；與上方分頁同一檔）
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CsvChart
                      key={`${c.id}-${c.file.name}-${c.file.size}-${c.file.lastModified}`}
                      file={c.file}
                    />
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      ) : null}

      {printItem ? (
        <div
          className="hidden print:block print:break-inside-avoid"
          aria-hidden
        >
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            {printItem.file.name}
          </h2>
          <div className="prose-p:leading-relaxed text-sm text-foreground">
            <FaeMarkdown>{printItem.markdown}</FaeMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}
