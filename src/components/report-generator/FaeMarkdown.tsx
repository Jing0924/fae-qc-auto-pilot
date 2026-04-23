"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function FaeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children: c }) => (
          <h1 className="mb-3 mt-2 text-xl font-bold tracking-tight">{c}</h1>
        ),
        h2: ({ children: c }) => (
          <h2 className="mb-2 mt-6 text-base font-semibold">{c}</h2>
        ),
        p: ({ children: c }) => (
          <p className="mb-3 text-foreground/90">{c}</p>
        ),
        ul: ({ children: c }) => (
          <ul className="mb-3 list-disc space-y-1 pl-5">{c}</ul>
        ),
        ol: ({ children: c }) => (
          <ol className="mb-3 list-decimal space-y-1 pl-5">{c}</ol>
        ),
        li: ({ children: c }) => <li className="text-foreground/90">{c}</li>,
        code: ({ className, children: c, ...props }) => {
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
                {c}
              </code>
            );
          }
          return (
            <code
              className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
              {...props}
            >
              {c}
            </code>
          );
        },
        pre: ({ children: c }) => <pre className="mb-3">{c}</pre>,
        table: ({ children: c }) => (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">{c}</table>
          </div>
        ),
        thead: ({ children: c }) => (
          <thead className="border-b bg-muted/50">{c}</thead>
        ),
        th: ({ children: c }) => <th className="px-2 py-2 font-medium">{c}</th>,
        td: ({ children: c }) => (
          <td className="border-t px-2 py-2 text-foreground/90">{c}</td>
        ),
        hr: () => <hr className="my-6 border-border" />,
        blockquote: ({ children: c }) => (
          <blockquote className="mb-3 border-l-2 pl-3 text-muted-foreground italic">
            {c}
          </blockquote>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
