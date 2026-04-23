export function buildReportDownloadFilename(uploaded: File | null): string {
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
