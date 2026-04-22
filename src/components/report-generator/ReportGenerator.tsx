"use client";

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Download,
  FileText,
  FileUp,
  Loader2,
  Sparkles,
  TriangleAlert,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type StreamStatus = "idle" | "streaming" | "done" | "error";

function buildReportDownloadFilename(uploaded: File | null): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  const name = uploaded?.name?.trim();
  if (!name) {
    return `fae-report-${Date.now()}.md`;
  }

  const cleaned = name.replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, "-");
  const dot = cleaned.lastIndexOf(".");
  const base = (dot > 0 ? cleaned.slice(0, dot) : cleaned).slice(0, 80) || "upload";
  return `fae-report-${base}-${stamp}.md`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReportGenerator() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resetStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const onFileChosen = useCallback((next: File | null) => {
    setFile(next);
    setPreview("");
    setErrorMessage(null);
    setStatus("idle");
    resetStream();
  }, [resetStream]);

  const generateReport = useCallback(async () => {
    if (!file) {
      setErrorMessage("請先選擇檔案。");
      setStatus("error");
      return;
    }

    resetStream();
    const controller = new AbortController();
    abortRef.current = controller;

    setPreview("");
    setErrorMessage(null);
    setStatus("streaming");

    const body = new FormData();
    body.set("file", file);

    try {
      const res = await fetch("/api/report", {
        method: "POST",
        body,
        signal: controller.signal,
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
        setPreview(accumulated);
      }

      setStatus("done");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStatus("idle");
        return;
      }
      setErrorMessage(e instanceof Error ? e.message : "Unknown error");
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }, [file, resetStream]);

  const downloadReport = useCallback(() => {
    if (preview.trim().length === 0) return;

    const blob = new Blob([preview], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildReportDownloadFilename(file);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [file, preview]);

  const statusBadge = () => {
    switch (status) {
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
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="border-border/80 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileUp className="size-5 opacity-80" />
            資料匯入
          </CardTitle>
          <CardDescription>
            支援文字 Log 或 CSV；內容會送至 Gemini 做結構化分析（長檔會截斷後送模型）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={cn(
              "flex min-h-[200px] w-full min-w-0 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center transition-colors",
              isDragging
                ? "border-primary bg-accent/40"
                : file
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
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) onFileChosen(dropped);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="presentation"
          >
            <input
              id="fae-file-input"
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".log,.txt,.csv,text/plain,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                onFileChosen(f ?? null);
              }}
            />
            <Sparkles className="mb-2 size-8 text-muted-foreground" />
            <p className="text-sm font-medium">拖放檔案至此，或點擊選擇</p>
            {file ? (
              <div className="mt-2 w-full max-w-full min-w-0 px-1">
                <p
                  className="truncate text-sm font-medium text-foreground"
                  title={file.name}
                >
                  {file.name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatFileSize(file.size)}
                </p>
              </div>
            ) : (
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                尚未選擇檔案
              </p>
            )}
          </div>

          {file ? (
            <div
              className="flex min-w-0 w-full items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2"
              aria-live="polite"
            >
              <FileText
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium text-foreground"
                  title={file.name}
                >
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(file.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  onFileChosen(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                清除
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={generateReport}
              disabled={!file || status === "streaming"}
              className="gap-2"
            >
              {status === "streaming" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              產生報告（Gemini 串流）
            </Button>
            {status === "streaming" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetStream();
                  setStatus("idle");
                }}
              >
                取消
              </Button>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-border/80 shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-lg">報告預覽</CardTitle>
            <CardDescription>Markdown 即時渲染（AI SDK 文字串流）</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {statusBadge()}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={preview.trim().length === 0}
              onClick={downloadReport}
              title="下載為 Markdown 檔（.md）"
              aria-label="下載報告為 Markdown 檔"
            >
              <Download className="size-4" />
              下載 Markdown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[min(560px,calc(100vh-12rem))] rounded-lg border bg-card">
            <div className="p-4 pr-6 text-sm leading-relaxed">
              {preview.length === 0 && status !== "streaming" ? (
                <p className="text-muted-foreground">
                  上傳檔案並開始產生後，報告會在此逐字顯示。
                </p>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children }) => (
                      <h1 className="mb-3 mt-2 text-xl font-bold tracking-tight">
                        {children}
                      </h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="mb-2 mt-6 text-base font-semibold">
                        {children}
                      </h2>
                    ),
                    p: ({ children }) => (
                      <p className="mb-3 text-foreground/90">{children}</p>
                    ),
                    ul: ({ children }) => (
                      <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="mb-3 list-decimal space-y-1 pl-5">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => <li className="text-foreground/90">{children}</li>,
                    code: ({ className, children, ...props }) => {
                      const isBlock = Boolean(className);
                      if (isBlock) {
                        return (
                          <code
                            className={cn(
                              "mb-3 block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs",
                              className,
                            )}
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      }
                      return (
                        <code
                          className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    pre: ({ children }) => <pre className="mb-3">{children}</pre>,
                    table: ({ children }) => (
                      <div className="mb-4 overflow-x-auto">
                        <table className="w-full border-collapse text-left text-xs">
                          {children}
                        </table>
                      </div>
                    ),
                    thead: ({ children }) => (
                      <thead className="border-b bg-muted/50">{children}</thead>
                    ),
                    th: ({ children }) => (
                      <th className="px-2 py-2 font-medium">{children}</th>
                    ),
                    td: ({ children }) => (
                      <td className="border-t px-2 py-2 text-foreground/90">
                        {children}
                      </td>
                    ),
                    hr: () => <hr className="my-6 border-border" />,
                    blockquote: ({ children }) => (
                      <blockquote className="mb-3 border-l-2 pl-3 text-muted-foreground italic">
                        {children}
                      </blockquote>
                    ),
                  }}
                >
                  {preview}
                </ReactMarkdown>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
