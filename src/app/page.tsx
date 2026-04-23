import { ReportGenerator } from "@/components/report-generator";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-card/50 px-6 py-6 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            FAE Auto Pilot · Demo
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            測試報告與品管分析
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            可一次上傳多份 Log 或 CSV，每份產一則可收合預覽的繁中 FAE
            分析報告；由 Gemini 透過 Vercel AI SDK 依序串流產生（需設定
            GEMINI_API_KEY）。
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            範例檔：
            <a
              className="ml-1 underline underline-offset-2 hover:text-foreground"
              href="/samples/fake-qc-lot.csv"
              download
            >
              fake-qc-lot.csv
            </a>
            <span className="mx-1.5 text-border">·</span>
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href="/samples/fake-test-run.log"
              download
            >
              fake-test-run.log
            </a>
          </p>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
        <ReportGenerator />
      </main>
    </div>
  );
}
