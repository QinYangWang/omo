import { useEffect, useRef, useState } from "react";
import { Asterisk, Brain, Check, Copy, Folder, FolderPlus, Gauge, GitBranch, LoaderCircle, Monitor, Wrench, X } from "lucide-react";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Select, SelectItem, SelectPopup, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";

type ChatMessage =
  | {
      id: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
      turnEnd?: boolean;
      completedAt?: number;
      durationMs?: number;
      copyText?: string;
    }
  | { id: string; role: "tool"; toolName: string; input?: string; output?: string; status: "running" | "done" | "error" }
  | { id: string; role: "thinking"; text: string; status: "running" | "done" };

// ponytail: 模块级消息缓存, 会话切换不丢; 持久化由 pi session 文件负责, 后续 get_messages 回放
const store = new Map<string, ChatMessage[]>();
const pages = new Map<string, { cursor: number; hasMore: boolean }>();

type ActiveSession = { key: string; cwd: string; project: string; title: string; path?: string };

const findLast = (items: ChatMessage[], predicate: (item: ChatMessage) => boolean) => {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
};

const formatTime = (timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(timestamp)
    : "";

const formatDuration = (ms?: number) => {
  if (ms == null) return "";
  const minutes = ms / 60_000;
  return minutes < 1 ? "<1 min" : `${Math.round(minutes)} min`;
};

const messageText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
      : "";

export function ChatView({
  session,
  projects,
  onSelectProject,
  onAddProject,
  onClearProject,
}: {
  session: ActiveSession | null;
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onAddProject: () => Promise<Project | null | undefined>;
  onClearProject: () => void;
}) {
  const key = session?.key ?? "draft";
  const [messages, setMessages] = useState<ChatMessage[]>(() => store.get(key) ?? []);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(() => pages.get(key) ?? { cursor: 0, hasMore: false });
  const [mode, setMode] = useState<"local" | "worktree">("local");
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const [models, setModels] = useState<{ id: string; provider: string; name: string }[]>([]);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    setMessages(store.get(key) ?? []);
    setPage(pages.get(key) ?? { cursor: 0, hasMore: false });
    if (!session || store.has(key)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    window.omo.pi
      .open(key, session.cwd, session.path)
      .then(({ messages: history, cursor, hasMore }) => {
        const restored = history as ChatMessage[];
        const nextPage = { cursor, hasMore };
        store.set(key, restored);
        pages.set(key, nextPage);
        if (keyRef.current === key) {
          setMessages(restored);
          setPage(nextPage);
          setLoading(false);
        }
      })
      .catch((error) => {
        const failed: ChatMessage[] = [{
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
        }];
        store.set(key, failed);
        if (keyRef.current === key) {
          setMessages(failed);
          setLoading(false);
        }
      });
  }, [key, session?.cwd, session?.path]);

  useEffect(() => {
    window.omo.pi.models().then((available) => {
      setModels(available);
      const preferred = available.find((item) => /luna/i.test(item.name)) ?? available[0];
      if (preferred) setModel((current) => current || `${preferred.provider}/${preferred.id}`);
    });
  }, []);

  useEffect(() => {
    if (!session) return setBranches([]);
    window.omo.git.branches(session.cwd).then(setBranches);
  }, [session?.cwd]);

  useEffect(() => {
    return window.omo.pi.onEvent(({ sessionId: sid, event }) => {
      if (sid !== keyRef.current) return;
      const apply = (fn: (m: ChatMessage[]) => ChatMessage[]) => {
        const next = fn(store.get(keyRef.current) ?? []);
        store.set(keyRef.current, next);
        setMessages(next);
      };
      if (event.type === "message_start" && event.message?.role === "assistant") {
        setStreaming(true);
      } else if (event.type === "message_update") {
        const ev = event.assistantMessageEvent;
        if (ev?.type === "thinking_start") {
          apply((m) => [...m, { id: crypto.randomUUID(), role: "thinking", text: "", status: "running" }]);
        } else if (ev?.type === "thinking_delta") {
          apply((m) => {
            const index = findLast(m, (item) => item.role === "thinking" && item.status === "running");
            return index < 0 ? m : m.map((item, i) => i === index && item.role === "thinking" ? { ...item, text: item.text + ev.delta } : item);
          });
        } else if (ev?.type === "thinking_end") {
          apply((m) => m.map((item) => item.role === "thinking" && item.status === "running" ? { ...item, status: "done" } : item));
        } else if (ev?.type === "text_start") {
          apply((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: "", timestamp: Date.now() }]);
        } else if (ev?.type === "text_delta") {
          apply((m) => {
            const index = findLast(m, (item) => item.role === "assistant");
            return index < 0 ? m : m.map((item, i) => i === index && item.role === "assistant" ? { ...item, text: item.text + ev.delta } : item);
          });
        } else if (ev?.type === "toolcall_start") {
          apply((m) => [
            ...m,
            { id: ev.id, role: "tool", toolName: ev.toolName, status: "running" },
          ]);
        } else if (ev?.type === "toolcall_end") {
          apply((m) => m.map((item) =>
            item.role === "tool" && item.id === ev.toolCall?.id
              ? { ...item, input: JSON.stringify(ev.toolCall.arguments, null, 2) }
              : item
          ));
        }
      } else if (event.type === "tool_execution_end") {
        apply((m) => m.map((item) =>
          item.role === "tool" && item.id === event.toolCallId
            ? {
                ...item,
                output: messageText(event.result?.content),
                status: event.isError ? "error" : "done",
              }
            : item
        ));
      } else if (event.type === "agent_end") {
        const completedAt = Date.now();
        apply((m) => {
          const userIndex = findLast(m, (item) => item.role === "user");
          const assistantIndexes = m
            .map((item, index) => ({ item, index }))
            .filter(({ item, index }) => index > userIndex && item.role === "assistant");
          const last = assistantIndexes.at(-1);
          if (!last || last.item.role !== "assistant") return m;
          const user = m[userIndex];
          const copyText = assistantIndexes
            .map(({ item }) => item.role === "assistant" ? item.text : "")
            .filter(Boolean)
            .join("\n\n");
          return m.map((item, index) =>
            index === last.index && item.role === "assistant"
              ? {
                  ...item,
                  turnEnd: true,
                  completedAt,
                  durationMs: user?.role === "user" && user.timestamp ? completedAt - user.timestamp : undefined,
                  copyText,
                }
              : item
          );
        });
        setStreaming(false);
      }
    });
  }, []);

  const loadOlder = async () => {
    if (!page.hasMore) return;
    const result = await window.omo.pi.history(key, page.cursor);
    const next = [...(result.messages as ChatMessage[]), ...(store.get(key) ?? [])];
    const nextPage = { cursor: result.cursor, hasMore: result.hasMore };
    store.set(key, next);
    pages.set(key, nextPage);
    setMessages(next);
    setPage(nextPage);
  };

  const onSubmit = (m: PromptInputMessage) => {
    if (!m.text?.trim()) return;
    const next = [...(store.get(key) ?? []), { id: crypto.randomUUID(), role: "user" as const, text: m.text, timestamp: Date.now() }];
    store.set(key, next);
    setMessages(next);
    setStreaming(true);
    if (session) window.omo.pi.prompt(key, m.text, session.cwd, session.path);
  };

  const input = (
    <div>
      <PromptInput
        onSubmit={onSubmit}
        className="rounded-xl border border-white/[0.07] bg-[#202020] shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-white/[0.07] has-[[data-slot=input-group-control]:focus-visible]:ring-0"
      >
        <PromptInputBody>
          <PromptInputTextarea
            className="h-11 min-h-0 resize-none px-4 py-3 text-[15px]"
            placeholder="Do anything…"
          />
        </PromptInputBody>
        <PromptInputFooter className="px-3 pb-2.5 pt-0">
          <PromptInputTools className="gap-0.5">
            <CompactSelect
              icon={<Asterisk className="size-3.5" />}
              value={model}
              placeholder="Select model"
              items={models.map((item) => ({ value: `${item.provider}/${item.id}`, label: item.name }))}
              onChange={(value) => {
                setModel(value);
                const selected = models.find((item) => `${item.provider}/${item.id}` === value);
                if (session && selected) window.omo.pi.setModel(key, selected.provider, selected.id);
              }}
            />
            <CompactSelect
              value={thinking}
              items={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
                value,
                label: value[0].toUpperCase() + value.slice(1),
              }))}
              onChange={(value) => {
                setThinking(value);
                if (session) window.omo.pi.setThinking(key, value);
              }}
            />
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs text-muted-foreground">
              <Gauge className="size-3.5" /> 32k / 128k context
            </span>
          </PromptInputTools>
          <PromptInputSubmit
            status={streaming ? "streaming" : "ready"}
            className="rounded-full bg-white/[0.08] text-muted-foreground hover:bg-white/[0.12] hover:text-foreground"
          />
        </PromptInputFooter>
      </PromptInput>
      <div className="flex h-8 items-center gap-1 px-2 text-xs text-muted-foreground">
        <ProjectSelect
          projects={projects}
          value={session?.cwd ?? ""}
          onSelect={onSelectProject}
          onAdd={onAddProject}
          onClear={onClearProject}
        />
        <CompactSelect
          icon={<Monitor className="size-3.5" />}
          value={mode}
          items={[{ value: "local", label: "Local" }, { value: "worktree", label: "Worktree" }]}
          onChange={(value) => setMode(value as "local" | "worktree")}
        />
        <CompactSelect
          icon={<GitBranch className="size-3.5" />}
          value={branches.find((branch) => branch.current)?.name ?? ""}
          placeholder="No branch"
          items={branches.map((branch) => ({ value: branch.name, label: branch.name }))}
          onChange={() => {}}
          disabled={!branches.length}
        />
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="relative h-full overflow-hidden p-8">
        <div className="absolute left-1/2 top-[43%] -translate-x-1/2 -translate-y-1/2 text-center">
          <Asterisk className="mx-auto mb-5 size-7 text-orange-500" strokeWidth={1.6} />
          <div className="max-w-[70vw] truncate whitespace-nowrap text-xl font-normal">
            {session ? session.title : "Choose a project to start"}
          </div>
          {session && <div className="mt-1 text-sm text-muted-foreground">@ {session.project}</div>}
        </div>
        <div className="absolute bottom-5 left-1/2 w-[min(90%,760px)] -translate-x-1/2">{input}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto max-w-3xl">
          {page.hasMore && (
            <button
              type="button"
              onClick={loadOlder}
              className="mx-auto rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Load older messages
            </button>
          )}
          {messages.map((msg) =>
            msg.role === "tool" ? (
              <ToolMessage key={msg.id} message={msg} />
            ) : msg.role === "thinking" ? (
              <ThinkingMessage key={msg.id} message={msg} />
            ) : (
              <Message from={msg.role} key={msg.id}>
                <MessageContent>
                  <MessageResponse>{msg.text}</MessageResponse>
                </MessageContent>
                {msg.role === "user" ? (
                  <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                    <time>{formatTime(msg.timestamp)}</time>
                    <button
                      type="button"
                      className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100"
                      aria-label="Copy message"
                      title="Copy message"
                      onClick={() => navigator.clipboard.writeText(msg.text)}
                    >
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                ) : msg.turnEnd ? (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <button
                      type="button"
                      className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100"
                      aria-label="Copy answer"
                      title="Copy full answer"
                      onClick={() => navigator.clipboard.writeText(msg.copyText || msg.text)}
                    >
                      <Copy className="size-3.5" />
                    </button>
                    <time>{formatTime(msg.completedAt)}</time>
                    {msg.durationMs != null && <span>· {formatDuration(msg.durationMs)}</span>}
                  </div>
                ) : null}
              </Message>
            )
          )}
        </ConversationContent>
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">{input}</div>
    </div>
  );
}

function ProjectSelect({
  projects,
  value,
  onSelect,
  onAdd,
  onClear,
}: {
  projects: Project[];
  value: string;
  onSelect: (project: Project) => void;
  onAdd: () => Promise<Project | null | undefined>;
  onClear: () => void;
}) {
  const projectItems = projects.map((project) => ({ value: project.cwd, label: project.name }));
  const actions = [
    { value: "__new", label: "New project…" },
    { value: "__none", label: "Don't work in a project" },
  ];
  const items = [...projectItems, ...actions];
  return (
    <Select
      items={items}
      value={items.find((item) => item.value === value) ?? null}
      itemToStringValue={(item) => item.value}
      onValueChange={async (item) => {
        if (!item) return;
        if (item.value === "__new") {
          const project = await onAdd();
          if (project) onSelect(project);
        } else if (item.value === "__none") {
          onClear();
        } else {
          const project = projects.find((entry) => entry.cwd === item.value);
          if (project) onSelect(project);
        }
      }}
    >
      <SelectTrigger className="h-7 max-w-48 gap-1.5 rounded-md border-0 bg-white/[0.04] px-2.5 text-xs text-muted-foreground shadow-none hover:bg-white/[0.07] hover:text-foreground focus-visible:ring-0">
        <Folder className="size-3.5" />
        <SelectValue placeholder="Choose a project">
          {projects.find((project) => project.cwd === value)?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup className="min-w-56 p-1" alignItemWithTrigger={false} sideOffset={6}>
        {projectItems.map((item) => (
          <SelectItem key={item.value} value={item} className="min-h-8 rounded-md text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.label}</span>
            </span>
          </SelectItem>
        ))}
        {!!projectItems.length && <SelectSeparator className="my-1 bg-white/[0.07]" />}
        <SelectItem value={actions[0]} className="min-h-8 rounded-md text-sm text-foreground/80">
          <span className="flex items-center gap-2"><FolderPlus className="size-4" /> New project…</span>
        </SelectItem>
        <SelectItem value={actions[1]} className="min-h-8 rounded-md text-sm text-foreground/80">
          <span className="flex items-center gap-2"><X className="size-4" /> Don't work in a project</span>
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

function CompactSelect({
  items,
  value,
  placeholder,
  icon,
  disabled,
  onChange,
}: {
  items: { value: string; label: string }[];
  value: string;
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={items}
      value={items.find((item) => item.value === value) ?? null}
      onValueChange={(next) => next && onChange(next.value)}
      itemToStringValue={(item) => item.value}
      disabled={disabled}
    >
      <SelectTrigger className="h-7 max-w-48 gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-white/[0.05] hover:text-foreground focus-visible:ring-0">
        {icon}
        <SelectValue placeholder={placeholder}>
          {items.find((item) => item.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup className="min-w-44 p-1" alignItemWithTrigger={false} sideOffset={6}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item} className="text-sm">
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ThinkingMessage({ message }: { message: Extract<ChatMessage, { role: "thinking" }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl rounded-lg bg-white/[0.025] text-sm">
      <details open={message.status === "running"}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
          <Brain className="size-3.5" />
          <span className="text-xs">Thinking</span>
          {message.status === "running" ? (
            <LoaderCircle className="ml-auto size-3.5 animate-spin" />
          ) : (
            <Check className="ml-auto size-3.5 text-muted-foreground" />
          )}
        </summary>
        {message.text && (
          <div className="border-t border-white/[0.04] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-sans">{message.text}</pre>
          </div>
        )}
      </details>
    </div>
  );
}

function ToolMessage({ message }: { message: Extract<ChatMessage, { role: "tool" }> }) {
  const StatusIcon = message.status === "running" ? LoaderCircle : message.status === "error" ? X : Check;
  return (
    <div className="mx-auto w-full max-w-3xl rounded-lg border border-white/[0.06] bg-[#1d1d1d] text-sm">
      <details open={message.status === "running"}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground">
          <Wrench className="size-3.5" />
          <span className="font-mono text-xs">{message.toolName}</span>
          <StatusIcon className={`ml-auto size-3.5 ${message.status === "running" ? "animate-spin" : message.status === "error" ? "text-red-400" : "text-emerald-400"}`} />
        </summary>
        {(message.input || message.output) && (
          <div className="border-t border-white/[0.05] px-3 py-2">
            {message.input && <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{message.input}</pre>}
            {message.output && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{message.output}</pre>}
          </div>
        )}
      </details>
    </div>
  );
}
