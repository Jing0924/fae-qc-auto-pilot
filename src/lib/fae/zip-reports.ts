import JSZip from "jszip";

type ZipEntry = { filename: string; content: string };

function uniqueNameInSet(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    return desired;
  }
  let n = 0;
  let candidate = desired;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${String(n).padStart(3, "0")}-${desired}`;
  }
  return candidate;
}

export async function downloadReportsZip(
  entries: ZipEntry[],
  zipBasename: string,
): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const { filename, content } of entries) {
    const name = uniqueNameInSet(filename, used);
    used.add(name);
    zip.file(name, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipBasename.endsWith(".zip") ? zipBasename : `${zipBasename}.zip`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function buildZipDownloadBasename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `fae-reports-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}
