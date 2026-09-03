import { Check, ChevronRight, LoaderCircle, Wrench, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RenderBlock } from "@/lib/pi-adapter";
import { cn } from "@/lib/utils";

function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="typeset typeset-docs w-full max-w-full">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ReasoningBlock({
  content,
  status,
}: {
  content: string;
  status: "running" | "done";
}) {
  return (
    <details
      className="w-full rounded-lg bg-accent text-sm"
      open={status === "running"}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 in-open:rotate-90" />
        <span className="text-xs">Reasoning</span>
        {status === "running" ? (
          <LoaderCircle className="ml-auto size-3.5 animate-spin" />
        ) : null}
      </summary>
      {content ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-border border-t px-3 py-2 text-muted-foreground text-xs leading-relaxed">
          {content}
        </pre>
      ) : null}
    </details>
  );
}

function summarizeJson(input?: string) {
  if (!input) {
    return "";
  }
  const clean = input.trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}\n…` : clean;
}

function statusIcon(status: "running" | "done" | "error") {
  if (status === "running") {
    return LoaderCircle;
  }
  return status === "error" ? X : Check;
}

function ToolCallBlock({
  toolName,
  input,
  output,
  status,
}: {
  toolName: string;
  input?: string;
  output?: string;
  status: "running" | "done" | "error";
}) {
  const StatusIcon = statusIcon(status);
  return (
    <details
      className="w-full rounded-lg border border-border bg-card text-sm"
      open={status === "running"}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
        <Wrench className="size-3.5" />
        <span className="font-mono text-xs">{toolName}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {summarizeJson(input)}
        </span>
        <StatusIcon
          className={cn(
            "size-3.5",
            status === "running" && "animate-spin",
            status === "error" && "text-destructive",
            status === "done" && "text-success"
          )}
        />
      </summary>
      {input || output ? (
        <div className="border-border border-t">
          {input ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 text-muted-foreground text-xs">
              {input}
            </pre>
          ) : null}
          {output ? (
            <pre
              className={cn(
                "max-h-96 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs",
                input && "border-border border-t"
              )}
            >
              {output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function ErrorBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
      {content}
    </div>
  );
}

export function RenderBlocks({
  blocks,
  highlighted,
}: {
  blocks: RenderBlock[];
  highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2 transition-colors",
        highlighted && "rounded-lg bg-accent/40"
      )}
    >
      {blocks.map((block) => {
        if (block.type === "markdown") {
          return <MarkdownBlock content={block.content} key={block.id} />;
        }
        if (block.type === "reasoning") {
          return (
            <ReasoningBlock
              content={block.content}
              key={block.id}
              status={block.status}
            />
          );
        }
        if (block.type === "tool-call") {
          return (
            <ToolCallBlock
              input={block.input}
              key={block.id}
              output={block.output}
              status={block.status}
              toolName={block.toolName}
            />
          );
        }
        return <ErrorBlock content={block.content} key={block.id} />;
      })}
    </div>
  );
}
