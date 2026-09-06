import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  FileIcon,
  Folder01Icon,
  GlobeIcon,
  TerminalIcon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { File as DiffFile, PatchDiff } from "@pierre/diffs/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { getServerApi } from "@/lib/servers";
import { useTheme } from "@/lib/theme";
import { normalizeColorToHex } from "@/lib/theme-tokens";
import { cn, randomUUID } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";

interface PanelTab {
  closable?: boolean;
  cwd?: string;
  id: string;
  kind: "browser" | "diff" | "file" | "review" | "terminal";
  path?: string;
  title?: string;
}

const baseName = (p: string) => p.split("/").pop() ?? p;

export function Workspace({ serverId }: { serverId?: string }) {
  const { t } = useI18n();
  const api = getServerApi(serverId);
  const [tabs, setTabs] = useState<PanelTab[]>([
    { id: "review", kind: "review" },
  ]);
  const [activeId, setActiveId] = useState("review");

  const openTab = (tab: PanelTab) => {
    setTabs((current) =>
      current.some((item) => item.id === tab.id) ? current : [...current, tab]
    );
    setActiveId(tab.id);
  };
  const closeTab = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeId === id) {
      setActiveId("review");
    }
  };
  const tabLabel = (tab: PanelTab) => {
    if (tab.title) {
      return tab.title;
    }
    if (tab.kind === "review") {
      return t("surface_review");
    }
    if (tab.kind === "browser") {
      return t("surface_browser");
    }
    return t("surface_terminal");
  };
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeFilePath =
    activeTab?.kind === "file" ? activeTab.path : undefined;
  const renderTab = (tab: PanelTab) => {
    if (tab.kind === "review") {
      return (
        <ReviewSurface
          api={api}
          key={serverId}
          onOpenDiff={(cwd, file) =>
            openTab({
              closable: true,
              cwd,
              id: `diff:${file}`,
              kind: "diff",
              path: file,
              title: baseName(file),
            })
          }
        />
      );
    }
    if (tab.kind === "file" && tab.path) {
      return <FileTab api={api} path={tab.path} />;
    }
    if (tab.kind === "diff" && tab.path && tab.cwd) {
      return <DiffTab api={api} cwd={tab.cwd} file={tab.path} />;
    }
    return (
      <div className="h-full p-2">
        {tab.kind === "browser" ? (
          <BrowserSurface />
        ) : (
          <TerminalSurface api={api} />
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col bg-panel">
      <Tabs className="contents" onValueChange={setActiveId} value={activeId}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-2">
          <TabsList
            aria-label="Workspace tabs"
            className="gap-2 bg-transparent p-0"
          >
            {tabs.map((tab) => (
              <TabsTrigger
                className="h-8 gap-1.5 rounded-md px-3.5 text-xs"
                key={tab.id}
                value={tab.id}
              >
                {tabLabel(tab)}
                {tab.closable ? (
                  <Button
                    aria-label={t("close")}
                    className="inline-flex size-4 items-center justify-center border-0 text-foreground hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0 dark:hover:bg-transparent"
                    nativeButton={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    render={<span />}
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-3.5" icon={XIcon} />
                  </Button>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={t("add_tab")}
                  className="size-7"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <HugeiconsIcon className="size-4" icon={Add01Icon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onClick={() =>
                  openTab({
                    closable: true,
                    id: `browser:${randomUUID()}`,
                    kind: "browser",
                  })
                }
              >
                <HugeiconsIcon className="size-3.5" icon={GlobeIcon} />
                {t("surface_browser")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  openTab({
                    closable: true,
                    id: `terminal:${randomUUID()}`,
                    kind: "terminal",
                  })
                }
              >
                <HugeiconsIcon className="size-3.5" icon={TerminalIcon} />
                {t("surface_terminal")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Tabs>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {tabs.map((tab) => (
            <div
              className={tab.id === activeId ? "h-full" : "hidden"}
              key={tab.id}
            >
              {renderTab(tab)}
            </div>
          ))}
        </main>
        <aside className="w-[clamp(240px,19vw,300px)] shrink-0 border-border border-l">
          <FilesSurface
            activePath={activeFilePath}
            api={api}
            key={serverId}
            onOpenFile={(path) =>
              openTab({
                closable: true,
                id: `file:${path}`,
                kind: "file",
                path,
                title: baseName(path),
              })
            }
          />
        </aside>
      </div>
    </div>
  );
}

function BrowserSurface() {
  const [url, setUrl] = useState("http://localhost:5173");
  const ref = useRef<WebviewElement>(null);
  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        className="h-8 rounded-md"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            ref.current?.loadURL(url);
          }
        }}
        value={url}
      />
      <webview
        className="min-h-0 flex-1 rounded-md border"
        ref={ref}
        src={url}
      />
    </div>
  );
}

function TerminalSurface({ api }: { api: omoApi }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cssVar = (name: string) =>
      normalizeColorToHex(
        getComputedStyle(document.documentElement).getPropertyValue(name)
      );
    const term = new XTerm({
      convertEol: true,
      fontSize: 13,
      theme: {
        background: cssVar("--background") ?? "#1a1a1a",
        foreground: cssVar("--foreground") ?? "#d4d4d4",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const element = ref.current;
    if (element === null) {
      return;
    }
    term.open(element);
    fit.fit();
    api.term.create();
    const off = api.term.onData((d) => term.write(d));
    term.onData((d) => api.term.input(d));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(element);
    return () => {
      off();
      ro.disconnect();
      term.dispose();
    };
  }, [api]);
  return (
    <div
      className="h-full overflow-hidden rounded-md bg-background"
      ref={ref}
    />
  );
}

interface FNode {
  children?: FNode[];
  dir: boolean;
  name: string;
  open?: boolean;
  path: string;
}

function FileNodeToggle({ node }: { node: FNode }) {
  if (!node.dir) {
    return <span className="w-3.5" />;
  }
  return node.open ? (
    <HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
  ) : (
    <HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
  );
}

function FilesSurface({
  activePath,
  api,
  onOpenFile,
}: {
  activePath?: string;
  api: omoApi;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const [root, setRoot] = useState<FNode[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.cwd().then(async (cwd) => {
      const entries = await api.fs.list(cwd);
      setRoot(entries.map((e) => ({ ...e, path: `${cwd}/${e.name}` })));
    });
  }, [api]);

  const toggle = async (node: FNode) => {
    if (!node.dir) {
      onOpenFile(node.path);
      return;
    }
    if (!node.children) {
      const entries = await api.fs.list(node.path);
      node.children = entries.map((e) => ({
        ...e,
        path: `${node.path}/${e.name}`,
      }));
    }
    node.open = !node.open;
    setRoot([...root]);
  };

  const filterNodes = (nodes: FNode[], q: string): FNode[] => {
    if (!q) {
      return nodes;
    }
    const out: FNode[] = [];
    for (const n of nodes) {
      const kids = n.children ? filterNodes(n.children, q) : [];
      if (n.name.toLowerCase().includes(q) || kids.length > 0) {
        out.push({ ...n, children: kids, open: true });
      }
    }
    return out;
  };

  const renderNodes = (nodes: FNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.path}>
        <Button
          className={cn(
            "h-auto w-full justify-start gap-1 rounded px-1.5 py-1 font-normal text-[13px]",
            n.path === activePath && "bg-accent"
          )}
          onClick={() => toggle(n)}
          style={{ paddingLeft: depth * 14 + 6 }}
          variant="ghost"
        >
          <FileNodeToggle node={n} />
          {n.dir ? (
            <HugeiconsIcon className="size-3.5" icon={Folder01Icon} />
          ) : (
            <HugeiconsIcon className="size-3.5" icon={FileIcon} />
          )}
          <span className="truncate">{n.name}</span>
        </Button>
        {n.dir && n.open && n.children
          ? renderNodes(n.children, depth + 1)
          : null}
      </div>
    ));

  return (
    <div className="flex h-full flex-col">
      <div className="p-1.5">
        <Input
          aria-label={t("explorer_search")}
          className="h-8 text-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("explorer_search")}
          value={query}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1 pt-0">
          {renderNodes(filterNodes(root, query.trim().toLowerCase()), 0)}
        </div>
      </ScrollArea>
    </div>
  );
}

function ReviewSurface({
  api,
  onOpenDiff,
}: {
  api: omoApi;
  onOpenDiff: (cwd: string, file: string) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ file: string; xy: string }[]>([]);
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    api.cwd().then(async (c) => {
      setCwd(c);
      const out = await api.git.status(c);
      setStatus(
        out
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ file: l.slice(3), xy: l.slice(0, 2) }))
      );
    });
  }, [api]);

  return (
    <ScrollArea className="h-full">
      <div className="p-1">
        {status.length === 0 && (
          <p className="p-2 text-muted-foreground text-sm">{t("no_changes")}</p>
        )}
        {status.map((s) => (
          <Button
            className="h-auto w-full justify-start gap-2 rounded px-2 py-1 font-normal text-sm"
            key={s.file}
            onClick={() => onOpenDiff(cwd, s.file)}
            variant="ghost"
          >
            <span className="w-6 font-mono text-muted-foreground text-xs">
              {s.xy.trim() || "?"}
            </span>
            <span className="truncate">{s.file}</span>
          </Button>
        ))}
      </div>
    </ScrollArea>
  );
}

function FileTab({ api, path }: { api: omoApi; path: string }) {
  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      overflow: "wrap" as const,
      themeType: resolvedTheme,
    }),
    [resolvedTheme]
  );

  useEffect(() => {
    api.fs.read(path).then((r) => setContent(r.content ?? r.error ?? ""));
  }, [api, path]);

  if (content === null) {
    return null;
  }
  return (
    <ScrollArea className="h-full">
      <DiffFile
        className="p-2 text-xs"
        file={{ contents: content, name: baseName(path) }}
        options={options}
      />
    </ScrollArea>
  );
}

function DiffTab({
  api,
  cwd,
  file,
}: {
  api: omoApi;
  cwd: string;
  file: string;
}) {
  const { resolvedTheme } = useTheme();
  const [text, setText] = useState<string | null>(null);
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      disableFileHeader: true,
      overflow: "wrap" as const,
      themeType: resolvedTheme,
    }),
    [resolvedTheme]
  );

  useEffect(() => {
    api.git.diff(cwd, file).then(setText);
  }, [api, cwd, file]);

  if (text === null) {
    return null;
  }
  return (
    <ScrollArea className="h-full">
      <PatchDiff className="p-2 text-xs" options={options} patch={text} />
    </ScrollArea>
  );
}
