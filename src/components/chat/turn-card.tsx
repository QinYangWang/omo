import {
  AiBrain01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { MarkdownBlock } from "@/components/chat/render-blocks";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { ChatMessage, ConversationTurn } from "@/lib/conversation-turns";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ---------- shared helpers ----------

const imageSource = (image: { data: string; mimeType?: string }): string =>
  `data:${image.mimeType ?? "image/png"};base64,${image.data}`;

export function ImagePreviews({
  compact,
  images,
  onRemove,
}: {
  compact?: boolean;
  images: { data: string; id?: string; mimeType?: string; name?: string }[];
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => (
        <div className="group relative" key={image.id ?? index}>
          <img
            alt={image.name || "Attached image"}
            className={cn(
              "rounded-md object-cover",
              compact ? "size-14" : "size-20"
            )}
            src={imageSource(image)}
          />
          {onRemove && image.id ? (
            <Button
              aria-label={`Remove ${image.name || "image"}`}
              className="absolute top-1 right-1 size-6 rounded-full bg-background/90 text-muted-foreground opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onRemove(image.id as string)}
              size="icon"
              title="Remove image"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const formatTime = (timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: true,
        minute: "2-digit",
        weekday: "long",
      }).format(timestamp)
    : "";

export const formatDuration = (ms?: number) => {
  if (ms === undefined) {
    return "";
  }
  const minutes = ms / 60_000;
  return minutes < 1 ? "<1 min" : `${Math.round(minutes)} min`;
};

export const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
};

// ---------- segment model ----------

interface ToolItem {
  id: string;
  input?: string;
  name: string;
  output?: string;
  status: "done" | "error" | "running";
}

type Segment =
  | { id: string; kind: "markdown"; text: string; timestamp?: number }
  | { id: string; kind: "thinking"; running: boolean; text: string }
  | { id: string; kind: "tools"; tools: ToolItem[] };

function toSegments(items: ConversationTurn["items"]): Segment[] {
  const segments: Segment[] = [];
  const pushTools = (item: Extract<ChatMessage, { role: "tool" }>) => {
    const tool: ToolItem = {
      id: item.id,
      input: item.input,
      name: item.toolName,
      output: item.output,
      status: item.status,
    };
    const last = segments.at(-1);
    if (last?.kind === "tools") {
      last.tools.push(tool);
    } else {
      segments.push({ id: item.id, kind: "tools", tools: [tool] });
    }
  };
  for (const item of items) {
    if (item.role === "assistant") {
      if (!item.text) {
        continue;
      }
      segments.push({
        id: item.id,
        kind: "markdown",
        text: item.text,
        timestamp: item.timestamp,
      });
    } else if (item.role === "thinking") {
      segments.push({
        id: item.id,
        kind: "thinking",
        running: item.status === "running",
        text: item.text,
      });
    } else if (item.role === "tool") {
      pushTools(item);
    }
  }
  return segments;
}

// ---------- thinking ----------

function ThinkingSegment({
  segment,
}: {
  segment: Extract<Segment, { kind: "thinking" }>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground">
        <HugeiconsIcon className="size-3.5 shrink-0" icon={AiBrain01Icon} />
        <span className={cn(segment.running && "animate-pulse")}>
          {segment.running ? t("turn_thinking_active") : t("turn_thinking")}
        </span>
        {segment.running ? <Spinner className="size-3" /> : null}
        <HugeiconsIcon
          className={cn(
            "ml-auto size-3.5 transition-transform",
            open && "rotate-90"
          )}
          icon={ArrowRight01Icon}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs leading-5">
          {segment.text || "…"}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------- tools ----------

function ToolStatusIcon({ status }: { status: ToolItem["status"] }) {
  if (status === "running") {
    return <Spinner className="size-3" />;
  }
  if (status === "error") {
    return (
      <HugeiconsIcon
        className="size-3.5 text-destructive"
        icon={Cancel01Icon}
      />
    );
  }
  return <HugeiconsIcon className="size-3.5 text-success" icon={Tick02Icon} />;
}

function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent">
        <HugeiconsIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          icon={ArrowRight01Icon}
        />
        <span className="font-mono text-xs">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {open ? "" : summarize(tool.input)}
        </span>
        <ToolStatusIcon status={tool.status} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {tool.input ? (
          <pre className="mx-2 mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
            {tool.input}
          </pre>
        ) : null}
        {tool.output ? (
          <pre
            className={cn(
              "mx-2 mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/50 px-2 py-1.5 text-[11px]",
              tool.status === "error" && "text-destructive"
            )}
          >
            {tool.output}
          </pre>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function summarize(input?: string) {
  if (!input) {
    return "";
  }
  const clean = input.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

function ToolsSegment({
  segment,
}: {
  segment: Extract<Segment, { kind: "tools" }>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const runningTool = segment.tools.find((tool) => tool.status === "running");
  const errors = segment.tools.filter((tool) => tool.status === "error").length;
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground">
        <HugeiconsIcon className="size-3.5 shrink-0" icon={Wrench01Icon} />
        <span>{t("turn_tools", { count: String(segment.tools.length) })}</span>
        {runningTool ? (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            <Spinner className="size-3 shrink-0" />
            <span className="truncate font-mono">{runningTool.name}</span>
          </span>
        ) : null}
        {!runningTool && errors > 0 ? (
          <span className="text-destructive">
            {t("turn_tools_failed", { count: String(errors) })}
          </span>
        ) : null}
        <HugeiconsIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform",
            open && "rotate-90"
          )}
          icon={ArrowRight01Icon}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5 flex flex-col">
          {segment.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------- turn card ----------

export function TurnCard({
  highlighted,
  streaming,
  turn,
}: {
  highlighted?: boolean;
  streaming?: boolean;
  turn: ConversationTurn;
}) {
  const { t } = useI18n();
  const segments = toSegments(turn.items);
  const completed = turn.items
    .filter(
      (item): item is Extract<ChatMessage, { role: "assistant" }> =>
        item.role === "assistant"
    )
    .find((item) => item.turnEnd);
  const answer = turn.items
    .flatMap((item) => (item.role === "assistant" ? [item.text] : []))
    .filter(Boolean)
    .join("\n\n");
  const lastSegment = segments.at(-1);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2">
      <div
        className={cn(
          "rounded-lg transition-all duration-300",
          highlighted
            ? "bg-accent/40 ring-1 ring-primary/40"
            : "ring-1 ring-transparent"
        )}
      >
        {turn.user.text || turn.user.images ? (
          <div className="group/user flex flex-col items-end gap-1 px-2 pt-1">
            <div
              className={cn(
                "max-w-full rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed",
                highlighted && "bg-accent"
              )}
            >
              {turn.user.images ? (
                <div className="mb-2">
                  <ImagePreviews images={turn.user.images} />
                </div>
              ) : null}
              {turn.user.text ? (
                <p className="whitespace-pre-wrap">{turn.user.text}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs opacity-0 transition-opacity group-hover/user:opacity-100">
              <time>{formatTime(turn.user.timestamp)}</time>
              <Button
                aria-label="Copy01Icon message"
                className="size-6"
                onClick={() =>
                  copyToClipboard(turn.user.text).catch(() => undefined)
                }
                size="icon"
                title="Copy01Icon message"
                variant="ghost"
              >
                <HugeiconsIcon className="size-3.5" icon={Copy01Icon} />
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1 px-2 pt-1 pb-2 text-[15px] leading-relaxed">
          {segments.map((segment) => {
            if (segment.kind === "thinking") {
              return <ThinkingSegment key={segment.id} segment={segment} />;
            }
            if (segment.kind === "tools") {
              return <ToolsSegment key={segment.id} segment={segment} />;
            }
            return (
              <div key={segment.id}>
                <MarkdownBlock content={segment.text} />
                {streaming && segment === lastSegment ? (
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/70 align-text-bottom" />
                ) : null}
              </div>
            );
          })}
          {streaming && !segments.length ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs">
              <Spinner className="size-3" />
              <span className="animate-pulse">{t("turn_working")}</span>
            </div>
          ) : null}
        </div>
        {completed ? (
          <div className="flex items-center gap-2 px-2 pb-1 text-muted-foreground text-xs">
            <span>{formatDuration(completed.durationMs)}</span>
            <Button
              aria-label="Copy01Icon answer"
              className="size-6 opacity-60 hover:opacity-100"
              onClick={() => copyToClipboard(answer).catch(() => undefined)}
              size="icon"
              title="Copy01Icon full answer"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={Copy01Icon} />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
