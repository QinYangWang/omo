import { useEffect, useMemo, useRef, useState } from "react";
import { Asterisk, Check, ChevronRight, Copy, Folder, FolderPlus, Gauge, GitBranch, LoaderCircle, Monitor, Search, Wrench, X } from "lucide-react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProviderIcon } from "@/components/provider-icon";
import { RenderBlocks } from "@/components/chat/render-blocks";
import { adaptPiEvent, adaptPiMessages, type RenderBlock } from "@/lib/pi-adapter";
import { appendMessages, prependWindow, type ChatMessage, type ConversationTurn, type TurnWindow, windowFromMessages } from "@/lib/conversation-turns";
import type { UserMessage } from "@/lib/conversation-turns";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";

type ActiveSession = { key: string; cwd: string; project: string; title: string; path?: string };

const windows = new Map<string, TurnWindow>();

const formatTime = (timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(timestamp)
    : "";

const formatDuration = (ms?: number) => {
  if (ms == null) return "";
  const minutes = ms / 60_000;
  return minutes < 1 ? "<1 min" : `${Math.round(minutes)} min`;
};

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return;
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

function Outline({
  metas,
  activeId,
  onJump,
}: {
  metas: TurnWindow["metas"];
  activeId?: string;
  onJump: (turnId: string) => void;
}) {
  if (!metas.length) return null;
  const activeIndex = metas.findIndex((meta) => meta.id === activeId);
  const maxVisible = 48;
  const start = activeIndex >= 0 ? Math.max(0, Math.min(metas.length - maxVisible, activeIndex - Math.floor(maxVisible / 2))) : Math.max(0, metas.length - maxVisible);
  const visible = metas.slice(start, start + maxVisible);
  return (
    <aside className="pointer-events-none absolute right-4 top-1/2 z-10 -translate-y-1/2">
      <div className="pointer-events-auto flex flex-col items-end justify-center gap-1.5 py-2">
        {visible.map((meta) => {
          const active = meta.id === activeId;
          return (
            <div key={meta.id} className="group relative flex h-4 items-center justify-end">
              <button
                type="button"
                aria-label="Go to user message"
                onClick={() => onJump(meta.id)}
                className={`h-px w-4 rounded-full transition-all duration-150 ${
                  active ? "bg-foreground" : "bg-muted-foreground/40"
                } group-hover:w-10 group-hover:bg-foreground`}
              />
              <div className="pointer-events-none absolute right-12 top-1/2 hidden w-64 -translate-y-1/2 rounded-lg border border-border bg-popover p-3 text-left shadow-lg group-hover:block">
                <div className="mb-1 text-[11px] text-muted-foreground">User message</div>
                <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-foreground">{meta.userPreview}</p>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function TurnCard({ turn, highlighted }: { turn: ConversationTurn; highlighted?: boolean }) {
  const userBlock: RenderBlock = { id: turn.user.id, type: "markdown", content: turn.user.text, timestamp: turn.user.timestamp };
  const blocks = [userBlock, ...adaptPiMessages(turn.items)];
  const answer = turn.items.flatMap((item) => item.role === "assistant" ? [item.text] : []).filter(Boolean).join("\n\n");
  const completed = turn.items.find((item) => item.role === "assistant" && item.turnEnd);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-1">
      <div className={highlighted ? "rounded-lg bg-accent/30 transition-colors" : "transition-colors"}>
        <div className="flex justify-end">
          <div className="max-w-full rounded-2xl bg-secondary px-5 py-3 text-[15px] leading-relaxed text-secondary-foreground">
            <RenderBlocks blocks={[userBlock]} />
          </div>
        </div>
        <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <time>{formatTime(turn.user.timestamp)}</time>
          <button type="button" className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100" aria-label="Copy message" title="Copy message" onClick={() => void copyToClipboard(turn.user.text)}>
            <Copy className="size-3.5" />
          </button>
        </div>
        <div className="mt-2 text-[15px] leading-relaxed">
          <RenderBlocks blocks={blocks.slice(1)} />
        </div>
        {completed?.role === "assistant" && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <button type="button" className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100" aria-label="Copy answer" title="Copy full answer" onClick={() => void copyToClipboard(answer || completed.text)}>
              <Copy className="size-3.5" />
            </button>
            <time>{formatTime(completed.completedAt)}</time>
            {completed.durationMs != null && <span>· {formatDuration(completed.durationMs)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

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
  onAddProject: (path?: string) => Promise<Project | null | undefined>;
  onClearProject: () => void;
}) {
  const { t } = useI18n();
  const key = session?.key ?? "draft";
  const [turnWindow, setTurnWindow] = useState<TurnWindow>(() => windows.get(key) ?? windowFromMessages([], 0, false));
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"local" | "worktree">("local");
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const [models, setModels] = useState<{ id: string; provider: string; name: string }[]>([]);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const [text, setText] = useState("");
  const [visibleRange, setVisibleRange] = useState<ListRange>();
  const [highlightedId, setHighlightedId] = useState<string>();
  const virtuoso = useRef<VirtuosoHandle>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const turnIndex = new Map(turnWindow.turns.map((turn, index) => [turn.id, index]));
  const visibleTurn = visibleRange
    ? turnWindow.turns[Math.min(Math.max(0, visibleRange.startIndex), Math.max(0, turnWindow.turns.length - 1))]
    : undefined;

  const setWindow = (next: TurnWindow) => {
    windows.set(keyRef.current, next);
    setTurnWindow((current) => (keyRef.current === key ? next : current));
  };

  const loadOlder = async () => {
    const current = windows.get(keyRef.current) ?? turnWindow;
    if (!session || !current.hasOlder) return;
    const result = await omo.pi.history(keyRef.current, current.startCursor);
    setWindow(prependWindow(current, result.messages as ChatMessage[], result.cursor, result.hasMore));
  };

  const jumpTo = (turnId: string) => {
    const index = turnIndex.get(turnId);
    if (index == null) return;
    const currentIndex = visibleTurn ? turnIndex.get(visibleTurn.id) ?? index : index;
    const near = Math.abs(index - currentIndex) < 30;
    virtuoso.current?.scrollToIndex({ index, align: "center", behavior: near ? "smooth" : "auto" });
    window.setTimeout(() => virtuoso.current?.scrollToIndex({ index, align: "center", behavior: "auto" }), near ? 350 : 80);
    setHighlightedId(turnId);
    window.setTimeout(() => setHighlightedId((id) => (id === turnId ? undefined : id)), 1200);
  };

  useEffect(() => {
    const cached = windows.get(key);
    setTurnWindow(cached ?? windowFromMessages([], 0, false));
    if (!session || cached) {
      setLoading(false);
      return;
    }
    setLoading(true);
    omo.pi.open(key, session.cwd, session.path)
      .then(({ messages: history, cursor, hasMore, model: sessionModel, thinkingLevel }) => {
        setWindow(windowFromMessages(history as ChatMessage[], cursor, hasMore));
        if (sessionModel) setModel(`${sessionModel.provider}/${sessionModel.id}`);
        if (thinkingLevel) setThinking(thinkingLevel);
        setLoading(false);
      })
      .catch((error) => {
        const failed: ChatMessage[] = [{ id: crypto.randomUUID(), role: "assistant", text: `Failed to open session: ${error instanceof Error ? error.message : String(error)}` }];
        setWindow(windowFromMessages(failed, 0, false));
        setLoading(false);
      });
  }, [key, session?.cwd, session?.path]);

  useEffect(() => {
    omo.pi.models().then((available) => {
      setModels(available);
      const preferred = available.find((item) => /luna/i.test(item.name)) ?? available[0];
      if (preferred) setModel((current) => current || `${preferred.provider}/${preferred.id}`);
    });
  }, []);

  useEffect(() => {
    if (!session) return setBranches([]);
    omo.git.branches(session.cwd).then(setBranches);
  }, [session?.cwd]);

  useEffect(() => {
    return omo.pi.onEvent(({ sessionId: sid, event }) => {
      if (sid !== keyRef.current) return;
      if (event.type === "message_start" && event.message?.role === "assistant") setStreaming(true);
      if (event.type === "agent_end") {
        setStreaming(false);
        const current = windows.get(keyRef.current);
        if (!current) return;
        const next: TurnWindow = { ...current, turns: current.turns.map((turn) => ({ ...turn, items: [...turn.items] })) };
        const last = next.turns.at(-1);
        if (!last) return;
        const lastAssistantIndex = last.items.map((item, index) => ({ item, index })).filter(({ item }) => item.role === "assistant").at(-1)?.index;
        if (lastAssistantIndex == null) return;
        const completedAt = Date.now();
        last.items = last.items.map((item, index) => index === lastAssistantIndex && item.role === "assistant"
          ? {
              ...item,
              turnEnd: true,
              completedAt,
              durationMs: last.user.timestamp ? completedAt - last.user.timestamp : undefined,
            }
          : item
        );
        setWindow(next);
        return;
      }
      const current = windows.get(keyRef.current);
      if (!current) return;
      const next: TurnWindow = { ...current, turns: current.turns.map((turn) => ({ ...turn, items: [...turn.items] })) };
      const last = next.turns.at(-1);
      if (!last) return;
      last.items = adaptPiEventBlocks(last, event);
      setWindow(next);
    });
  }, []);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    const current = windows.get(key) ?? turnWindow;
    const next = appendMessages(current, [{ id: crypto.randomUUID(), role: "user", text: value, timestamp: Date.now() }]);
    setWindow(next);
    setText("");
    setStreaming(true);
    if (session) omo.pi.prompt(key, value, session.cwd, session.path);
  };

  const input = (
    <div>
      <div className="mb-2 flex h-8 items-center gap-1 px-1 text-xs text-muted-foreground">
        <ProjectSelect projects={projects} value={session?.cwd ?? ""} onSelect={onSelectProject} onAdd={onAddProject} onClear={onClearProject} />
        <CompactSelect icon={<Monitor className="size-3.5" />} value={mode} items={[{ value: "local", label: t("local") }, { value: "worktree", label: t("worktree") }]} onChange={(value) => setMode(value as "local" | "worktree")} />
        <CompactSelect icon={<GitBranch className="size-3.5" />} value={branches.find((branch) => branch.current)?.name ?? ""} placeholder={t("no_branch")} items={branches.map((branch) => ({ value: branch.name, label: branch.name }))} onChange={() => {}} disabled={!branches.length} />
      </div>
      <form onSubmit={submit} className="overflow-hidden rounded-3xl border border-border bg-background">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="h-12 w-full resize-none overflow-hidden border-0 bg-transparent px-4 py-4 text-[15px] outline-none placeholder:text-muted-foreground"
          placeholder={t("prompt_placeholder")}
        />
        <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-0">
          <div className="flex items-center gap-2">
            <ModelSelect models={models} value={model} placeholder={t("select_model")} onChange={(value) => {
              setModel(value);
              const selected = models.find((item) => `${item.provider}/${item.id}` === value);
              if (session && selected) omo.pi.setModel(key, selected.provider, selected.id);
            }} />
            <CompactSelect value={thinking} items={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} onChange={(value) => {
              setThinking(value);
              if (session) omo.pi.setThinking(key, value);
            }} />
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs text-muted-foreground">
              <Gauge className="size-3.5" /> 32k / 128k context
            </span>
          </div>
          <Button
            type={streaming ? "button" : "submit"}
            size="icon-sm"
            className={streaming
              ? "rounded-full border-0 bg-foreground text-background shadow-none hover:bg-foreground/90"
              : "rounded-full border-0 bg-accent text-muted-foreground shadow-none hover:bg-accent hover:text-foreground disabled:opacity-40"
            }
            disabled={!text.trim() && !streaming}
            onClick={streaming ? () => { void omo.pi.abort(key); setStreaming(false); } : undefined}
          >
            {streaming ? <X className="size-4" /> : <Check className="size-4" />}
          </Button>
        </div>
      </form>
    </div>
  );

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  }

  if (turnWindow.turns.length === 0) {
    return (
      <div className="relative h-full overflow-hidden p-8">
        <div className="absolute left-1/2 top-[43%] -translate-x-1/2 -translate-y-1/2 text-center">
          <Asterisk className="mx-auto mb-5 size-7 text-orange-500" strokeWidth={1.6} />
          <div className="max-w-[70vw] truncate whitespace-nowrap text-xl font-normal">{session ? session.title : t("choose_project_start")}</div>
          {session && <div className="mt-1 text-sm text-muted-foreground">@ {session.project}</div>}
        </div>
        <div className="absolute bottom-5 left-1/2 w-[min(90%,760px)] -translate-x-1/2">{input}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1">
        <Virtuoso
          className="h-full w-full"
          ref={virtuoso}
          data={turnWindow.turns}
          firstItemIndex={turnWindow.start}
          defaultItemHeight={160}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          followOutput="smooth"
          startReached={() => void loadOlder()}
          rangeChanged={setVisibleRange}
          itemContent={(_index, turn) => <TurnCard turn={turn} highlighted={turn.id === highlightedId} />}
        />
        <Outline metas={turnWindow.metas} activeId={visibleTurn?.id} onJump={jumpTo} />
      </div>
      <div className="mx-auto w-full max-w-3xl p-4">{input}</div>
    </div>
  );
}

function adaptPiEventBlocks(turn: ConversationTurn, event: any): ConversationTurn["items"] {
  const blocks = adaptPiEvent(adaptPiMessages(turn.items), event);
  const byId = new Map<string, ConversationTurn["items"][number]>();
  for (const block of blocks) {
    if (block.type === "markdown") {
      byId.set(block.id, { id: block.id, role: "assistant", text: block.content, timestamp: block.timestamp });
    } else if (block.type === "reasoning") {
      byId.set(block.id, { id: block.id, role: "thinking", text: block.content, status: block.status });
    } else if (block.type === "tool-call") {
      byId.set(block.id, { id: block.id, role: "tool", toolName: block.toolName, input: block.input, output: block.output, status: block.status });
    }
  }
  return [...byId.values()];
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
  const { t } = useI18n();
  const projectItems = projects.map((project) => ({ value: project.cwd, label: project.name }));
  const actions = [
    { value: "__new", label: t("new_project") },
    { value: "__none", label: t("no_project") },
  ];
  const items = [...projectItems, ...actions];
  return (
    <Select items={items} value={items.find((item) => item.value === value) ?? null} itemToStringValue={(item) => item.value} onValueChange={async (item) => {
      if (!item) return;
      if (item.value === "__new") {
        const project = await onAdd();
        if (project) onSelect(project);
      } else if (item.value === "__none") onClear();
      else {
        const project = projects.find((entry) => entry.cwd === item.value);
        if (project) onSelect(project);
      }
    }}>
      <SelectTrigger hideIcon className="h-7 min-h-0 min-w-0 w-fit max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-xs text-muted-foreground shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0">
        <Folder className="size-3.5" />
        <SelectValue placeholder={t("choose_project")}>{projects.find((project) => project.cwd === value)?.name}</SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-56 p-1" alignItemWithTrigger={false} sideOffset={6}>
        {projectItems.map((item) => (
          <SelectItem key={item.value} value={item} className="min-h-8 rounded-md text-sm">
            <span className="flex min-w-0 items-center gap-2"><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="whitespace-nowrap">{item.label}</span></span>
          </SelectItem>
        ))}
        {!!projectItems.length && <SelectSeparator className="my-1 bg-accent" />}
        <SelectItem value={actions[0]} className="min-h-8 rounded-md text-sm text-foreground/80"><span className="flex items-center gap-2"><FolderPlus className="size-4" /> {t("new_project")}</span></SelectItem>
        <SelectItem value={actions[1]} className="min-h-8 rounded-md text-sm text-foreground/80"><span className="flex items-center gap-2"><X className="size-4" /> {t("no_project")}</span></SelectItem>
      </SelectContent>
    </Select>
  );
}

function ModelSelect({ models, value, placeholder, onChange }: { models: { id: string; provider: string; name: string }[]; value: string; placeholder: string; onChange: (value: string) => void }) {
  const modelItems = models.map((item) => ({ ...item, value: `${item.provider}/${item.id}`, label: item.name }));
  const selected = modelItems.find((item) => item.value === value);
  const groups = [...new Set(modelItems.map((item) => item.provider))];
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected ? [selected.provider] : groups));
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matched = normalized
      ? modelItems.filter((item) => `${item.provider} ${item.label}`.toLowerCase().includes(normalized))
      : modelItems;
    return selected && !matched.some((item) => item.value === selected.value) ? [selected, ...matched] : matched;
  }, [modelItems, query, selected]);
  const filteredGroups = [...new Set(filtered.map((item) => item.provider))];
  const width = Math.min(560, Math.max(280, Math.max(...modelItems.map((item) => item.label.length), 20) * 8 + 72));

  return (
    <Select items={filtered} value={selected} onValueChange={(item) => item && onChange(item.value)} itemToStringValue={(item) => item.label}>
      <SelectTrigger hideIcon className="h-7 min-h-0 min-w-0 w-fit max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0">
        <ProviderIcon provider={selected?.provider} className="size-3.5 shrink-0" />
        <SelectValue placeholder={placeholder}>{selected?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent className="p-1" alignItemWithTrigger={false} sideOffset={6} style={{ width }}>
        <div className="mb-1 flex h-8 items-center gap-2 rounded-md border border-border px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Search models…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {filteredGroups.map((provider, index) => (
          <SelectGroup key={provider}>
            {index > 0 && <SelectSeparator className="my-1 bg-accent" />}
            <SelectLabel render={<button type="button" />} className="flex w-full cursor-pointer items-center justify-start gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(event) => {
              event.preventDefault();
              setExpanded((current) => { const next = new Set(current); next.has(provider) ? next.delete(provider) : next.add(provider); return next; });
            }}>
              <ChevronRight className={`size-3 shrink-0 transition-transform ${expanded.has(provider) || query ? "rotate-90" : ""}`} />
              <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
              {provider}
            </SelectLabel>
            {(expanded.has(provider) || !!query) && filtered.filter((item) => item.provider === provider).map((item) => (
              <SelectItem key={`${item.provider}/${item.id}`} value={item} className="min-h-8 rounded-md pl-7 text-sm">
                <span className="flex min-w-0 items-center gap-2"><ProviderIcon provider={item.provider} className="size-3.5 shrink-0" /><span className="truncate">{item.name}</span></span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {filtered.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No models found</div>}
      </SelectContent>
    </Select>
  );
}

function CompactSelect({ items, value, placeholder, icon, disabled, onChange }: { items: { value: string; label: string }[]; value: string; placeholder?: string; icon?: React.ReactNode; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Select items={items} value={items.find((item) => item.value === value) ?? null} onValueChange={(next) => next && onChange(next.value)} itemToStringValue={(item) => item.value} disabled={disabled}>
      <SelectTrigger hideIcon className="h-7 min-h-0 min-w-0 w-fit max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0">
        {icon}
        <SelectValue placeholder={placeholder}>{items.find((item) => item.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-44 p-1" alignItemWithTrigger={false} sideOffset={6}>
        {items.map((item) => <SelectItem key={item.value} value={item} className="text-sm">{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
