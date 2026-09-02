import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronRight, Copy, LoaderCircle, Wrench, X } from "lucide-react";
import type { RenderBlock } from "@/lib/pi-adapter";
import { cn } from "@/lib/utils";

function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="typeset typeset-docs w-full max-w-full">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ReasoningBlock({ content, status }: { content: string; status: "running" | "done" }) {
  return (
    <details open={status === "running"} className="w-full rounded-lg bg-accent text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 in-open:rotate-90" />
        <span className="text-xs">Reasoning</span>
        {status === "running" && <LoaderCircle className="ml-auto size-3.5 animate-spin" />}
      </summary>
      {content && <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">{content}</pre>}
    </details>
  );
}

function summarizeJson(input?: string) {
  if (!input) return "";
  const clean = input.trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}\n…` : clean;
}

function ToolCallBlock({ toolName, input, output, status }: { toolName: string; input?: string; output?: string; status: "running" | "done" | "error" }) {
  const StatusIcon = status === "running" ? LoaderCircle : status === "error" ? X : Check;
  return (
    <details open={status === "running"} className="w-full rounded-lg border border-border bg-card text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
        <Wrench className="size-3.5" />
        <span className="font-mono text-xs">{toolName}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summarizeJson(input)}</span>
        <StatusIcon className={cn("size-3.5", status === "running" && "animate-spin", status === "error" && "text-red-400", status === "done" && "text-emerald-400")} />
      </summary>
      {(input || output) && (
        <div className="border-t border-border">
          {input && <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-muted-foreground">{input}</pre>}
          {output && <pre className={cn("max-h-96 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs", input && "border-t border-border")}>{output}</pre>}
        </div>
      )}
    </details>
  );
}

function ErrorBlock({ content }: { content: string }) {
  return <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{content}</div>;
}

export function RenderBlocks({ blocks, highlighted }: { blocks: RenderBlock[]; highlighted?: boolean }) {
  return (
    <div className={cn("flex w-full flex-col gap-2 transition-colors", highlighted && "rounded-lg bg-accent/40")}> 
      {blocks.map((block) => {
        if (block.type === "markdown") return <MarkdownBlock key={block.id} content={block.content} />;
        if (block.type === "reasoning") return <ReasoningBlock key={block.id} content={block.content} status={block.status} />;
        if (block.type === "tool-call") return <ToolCallBlock key={block.id} toolName={block.toolName} input={block.input} output={block.output} status={block.status} />;
        return <ErrorBlock key={block.id} content={block.content} />;
      })}
    </div>
  );
}
