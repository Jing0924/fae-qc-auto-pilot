"use client";

import { useCallback, useRef, useState } from "react";
import {
  Archive,
  ChevronRight,
  Download,
  FileText,
  FileUp,
  Loader2,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CsvChart } from "@/components/csv-chart";
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
  file: File,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<void> {
  const body = new FormData();
  body.set("file", file);
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

export function ReportGenerator() {
  const [items, setItems] = useState<ReportItem[]>([]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resetStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const list = Array.from(fileList).filter((f) => f.size > 0);
    if (list.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...list.map((file) => ({
        id: crypto.randomUUID(),
        file,
        status: "idle" as const,
        markdown: "",
      })),
    ]);
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
    setGlobalError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [resetStream]);

  const isBatchBusy = items.some(
    (i) => i.status === "streaming" || i.status === "queued",
  );

  const toggleItem = useCallback((id: string) => {
    setOpenItemId((o) => (o === id ? null : id));
  }, []);

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

  const generateReports = useCallback(async () => {
    if (items.length === 0) {
      setGlobalError("請先加入至少一個檔案。");
      return;
    }
    if (isBatchBusy) return;

    const snapshot = items;
    setGlobalError(null);
    resetStream();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    try {
      for (let i = 0; i < snapshot.length; i++) {
        const { id, file } = snapshot[i];
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

        try {
          await streamReportForFile(file, signal, (text) => {
            setItems((prev) =>
              prev.map((x) => (x.id === id ? { ...x, markdown: text } : x)),
            );
          });
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
  }, [isBatchBusy, items, resetStream]);

  const cancelBatch = useCallback(() => {
    resetStream();
  }, [resetStream]);

  const hasZipEligible = items.some(
    (i) => i.status === "done" && i.markdown.trim().length > 0,
  );

  const csvItems = items.filter((i) => /\.csv$/i.test(i.file.name));

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="size-5 opacity-80" />
              資料匯入
            </CardTitle>
            <CardDescription>
              可選多份 Log 或 CSV；每份檔案會分別產生一份報告（依序串流，長檔同樣可能截斷後送模型）。
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

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={generateReports}
                disabled={items.length === 0 || isBatchBusy}
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
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-lg">報告預覽</CardTitle>
              <CardDescription>依檔收合；串流中會自動展開目前項目</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {aggregateBadge(items)}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={!hasZipEligible}
                onClick={() => void downloadAllZip()}
                title="下載多份 .md 為一個壓縮檔"
                aria-label="下載全部報告為 ZIP"
              >
                <Archive className="size-4" />
                下載全部（.zip）
              </Button>
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
                  return (
                    <li
                      key={item.id}
                      className="overflow-hidden rounded-lg border border-border/80 bg-card"
                    >
                      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
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
                          <Download className="size-3.5" />
                          .md
                        </Button>
                      </div>
                      {isOpen ? (
                        <div>
                          {item.error ? (
                            <p className="flex items-start gap-2 px-3 py-2 text-sm text-destructive">
                              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                              {item.error}
                            </p>
                          ) : null}
                          <div className="max-h-80 min-h-0 overflow-y-auto overflow-x-hidden pr-1">
                            <div className="p-3 text-sm leading-relaxed">
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
        <div className="space-y-4">
          {csvItems.map((item) => (
            <Card
              key={`${item.id}-csv`}
              className="border-border/80 shadow-sm"
            >
              <CardHeader>
                <CardTitle>CSV 視覺化</CardTitle>
                <CardDescription className="truncate" title={item.file.name}>
                  {item.file.name}（純前端）
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CsvChart
                  key={`${item.file.name}-${item.file.size}-${item.file.lastModified}`}
                  file={item.file}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
