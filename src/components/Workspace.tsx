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
import { Unicode11Addon } from "@xterm/addon-unicode11";
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
import {
  buildChangedFileTree,
  parseGitStatus,
  type WorkspaceFileNode,
} from "@/lib/workspace-tree";
import "@xterm/xterm/css/xterm.css";

type FNode = WorkspaceFileNode;

interface WorkspaceTab {
  id: string;
  kind: "browser" | "files" | "review" | "terminal";
}

const pathSeparatorPattern = /[\\/]/;
const baseName = (path: string) =>
  path.split(pathSeparatorPattern).pop() ?? path;
const joinPath = (parent: string, child: string) => `${parent}/${child}`;

export function Workspace({
  cwd,
  serverId,
  terminalKey,
}: {
  cwd?: string;
  serverId?: string;
  terminalKey: string;
}) {
  const { t } = useI18n();
  const api = getServerApi(serverId);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "files", kind: "files" },
    { id: "review", kind: "review" },
  ]);
  const [activeTab, setActiveTab] = useState("files");
  const [projectCwd, setProjectCwd] = useState(cwd ?? "");

  useEffect(() => {
    if (cwd) {
      setProjectCwd(cwd);
      return;
    }
    api.cwd().then(setProjectCwd);
  }, [api, cwd]);

  const label = (tab: WorkspaceTab) => {
    if (tab.kind === "files") {
      return t("surface_files");
    }
    if (tab.kind === "review") {
      return t("surface_review");
    }
    return tab.kind === "terminal"
      ? t("surface_terminal")
      : t("surface_browser");
  };

  const addTab = (kind: "browser" | "terminal") => {
    const id = `${kind}:${randomUUID()}`;
    setTabs((current) => [...current, { id, kind }]);
    setActiveTab(id);
  };

  const closeTab = (tab: WorkspaceTab) => {
    if (tab.kind === "terminal") {
      api.term.close(`${terminalKey}:${tab.id}`).catch(() => undefined);
    }
    setTabs((current) => current.filter((item) => item.id !== tab.id));
    if (activeTab === tab.id) {
      setActiveTab("files");
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-panel">
      <Tabs className="contents" onValueChange={setActiveTab} value={activeTab}>
        <div className="flex h-12 shrink-0 items-center gap-1 border-border border-b px-2">
          <TabsList aria-label="Workspace" variant="line">
            {tabs.map((tab) => (
              <TabsTrigger
                className="h-8 gap-1 px-3 text-xs"
                key={tab.id}
                value={tab.id}
              >
                {label(tab)}
                {tab.kind === "terminal" || tab.kind === "browser" ? (
                  <Button
                    aria-label={t("close")}
                    className="size-4"
                    nativeButton={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab);
                    }}
                    render={<span />}
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={XIcon} />
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
              <HugeiconsIcon icon={Add01Icon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => addTab("terminal")}>
                <HugeiconsIcon icon={TerminalIcon} />
                {t("surface_terminal")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTab("browser")}>
                <HugeiconsIcon icon={GlobeIcon} />
                {t("surface_browser")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Tabs>
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            className={cn(
              tab.id === activeTab ? "h-full" : "hidden",
              (tab.kind === "terminal" || tab.kind === "browser") && "p-2"
            )}
            key={tab.id}
          >
            {tab.kind === "files" ? (
              <FilesSurface api={api} cwd={projectCwd} />
            ) : null}
            {tab.kind === "review" ? (
              <ReviewSurface api={api} cwd={projectCwd} />
            ) : null}
            {tab.kind === "terminal" ? (
              <TerminalSurface
                api={api}
                cwd={projectCwd}
                terminalKey={`${terminalKey}:${tab.id}`}
              />
            ) : null}
            {tab.kind === "browser" ? <BrowserSurface /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitSurface({
  children,
  tree,
}: {
  children: React.ReactNode;
  tree: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0">
      <aside className="w-[clamp(220px,19vw,300px)] shrink-0 border-border border-r">
        {tree}
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function BrowserSurface() {
  const [url, setUrl] = useState("http://localhost:5173");
  const ref = useRef<WebviewElement>(null);
  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        aria-label="URL"
        className="h-8 rounded-md"
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
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

function TerminalSurface({
  api,
  cwd,
  terminalKey,
}: {
  api: omoApi;
  cwd: string;
  terminalKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!(cwd && ref.current)) {
      return;
    }
    const element = ref.current;
    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string) =>
      normalizeColorToHex(styles.getPropertyValue(name));
    const terminal = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: styles.getPropertyValue("--font-geist-mono") || "monospace",
      fontSize: 13,
      lineHeight: 1,
      scrollback: 10_000,
      theme: {
        background: cssVar("--background") ?? undefined,
        foreground: cssVar("--foreground") ?? undefined,
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.open(element);
    terminal.focus();

    let disposed = false;
    let fontsReady = false;
    let frame = 0;
    let started = false;
    const resize = () => {
      if (disposed) {
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!(fontsReady && element.offsetWidth && element.offsetHeight)) {
          return;
        }
        fit.fit();
        if (!started) {
          started = true;
          api.term
            .create(cwd, terminal.cols, terminal.rows, terminalKey)
            .then(resize)
            .catch((error: unknown) => {
              started = false;
              terminal.writeln(
                `\r\nTerminal failed: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          return;
        }
        api.term.resize(terminal.cols, terminal.rows, terminalKey);
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      });
    };
    const off = api.term.onData((data) => terminal.write(data), terminalKey);
    const input = terminal.onData((data) => api.term.input(data, terminalKey));
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    document.fonts.ready.then(() => {
      fontsReady = true;
      resize();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      off();
      input.dispose();
      observer.disconnect();
      terminal.dispose();
    };
  }, [api, cwd, terminalKey]);

  return (
    <div
      className="h-full overflow-hidden rounded-md bg-background"
      ref={ref}
    />
  );
}

function FileNodeToggle({ node }: { node: FNode }) {
  if (!node.dir) {
    return <span className="w-3.5" />;
  }
  return (
    <HugeiconsIcon
      className="size-3.5"
      icon={node.open ? ArrowDown01Icon : ArrowRight01Icon}
    />
  );
}

function FileTree({
  activePath,
  nodes,
  onSelect,
  onToggle,
}: {
  activePath?: string;
  nodes: FNode[];
  onSelect: (node: FNode) => void;
  onToggle: (node: FNode) => void;
}) {
  const renderNodes = (items: FNode[], depth: number): React.ReactNode =>
    items.map((node) => (
      <div key={node.path}>
        <Button
          className={cn(
            "h-7 w-full justify-start gap-1 rounded px-1.5 font-normal text-[13px]",
            node.path === activePath && "bg-accent"
          )}
          onClick={() => (node.dir ? onToggle(node) : onSelect(node))}
          style={{ paddingLeft: depth * 14 + 6 }}
          variant="ghost"
        >
          <FileNodeToggle node={node} />
          <HugeiconsIcon
            className="size-3.5"
            icon={node.dir ? Folder01Icon : FileIcon}
          />
          <span className="truncate">{node.name}</span>
          {node.status ? (
            <span className="ml-auto font-mono text-muted-foreground text-xs">
              {node.status.trim() || "?"}
            </span>
          ) : null}
        </Button>
        {node.dir && node.open && node.children
          ? renderNodes(node.children, depth + 1)
          : null}
      </div>
    ));

  return <div className="p-1">{renderNodes(nodes, 0)}</div>;
}

function FilesSurface({ api, cwd }: { api: omoApi; cwd: string }) {
  const { t } = useI18n();
  const [root, setRoot] = useState<FNode[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();

  useEffect(() => {
    if (!cwd) {
      return;
    }
    setSelectedPath(undefined);
    api.fs.list(cwd).then((entries) =>
      setRoot(
        entries.map((entry) => ({
          ...entry,
          path: joinPath(cwd, entry.name),
        }))
      )
    );
  }, [api, cwd]);

  const toggle = async (node: FNode) => {
    if (!node.children) {
      const entries = await api.fs.list(node.path);
      node.children = entries.map((entry) => ({
        ...entry,
        path: joinPath(node.path, entry.name),
      }));
    }
    node.open = !node.open;
    setRoot([...root]);
  };

  const filterNodes = (nodes: FNode[], value: string): FNode[] => {
    if (!value) {
      return nodes;
    }
    const output: FNode[] = [];
    for (const node of nodes) {
      const children = node.children ? filterNodes(node.children, value) : [];
      if (node.name.toLowerCase().includes(value) || children.length > 0) {
        output.push({ ...node, children, open: true });
      }
    }
    return output;
  };

  const tree = (
    <div className="flex h-full flex-col">
      <div className="p-1.5">
        <Input
          aria-label={t("explorer_search")}
          className="h-8 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("explorer_search")}
          value={query}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <FileTree
          activePath={selectedPath}
          nodes={filterNodes(root, query.trim().toLowerCase())}
          onSelect={(node) => setSelectedPath(node.path)}
          onToggle={toggle}
        />
      </ScrollArea>
    </div>
  );

  return (
    <SplitSurface tree={tree}>
      {selectedPath ? <FileView api={api} path={selectedPath} /> : null}
    </SplitSurface>
  );
}

function ReviewSurface({ api, cwd }: { api: omoApi; cwd: string }) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<FNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();

  useEffect(() => {
    if (!cwd) {
      return;
    }
    setSelectedFile(undefined);
    api.git
      .status(cwd)
      .then((output) =>
        setNodes(buildChangedFileTree(cwd, parseGitStatus(output)))
      );
  }, [api, cwd]);

  const toggle = (node: FNode) => {
    node.open = !node.open;
    setNodes([...nodes]);
  };

  const tree = (
    <ScrollArea className="h-full">
      {nodes.length > 0 ? (
        <FileTree
          activePath={selectedFile ? joinPath(cwd, selectedFile) : undefined}
          nodes={nodes}
          onSelect={(node) => setSelectedFile(node.path.slice(cwd.length + 1))}
          onToggle={toggle}
        />
      ) : (
        <p className="p-3 text-muted-foreground text-sm">{t("no_changes")}</p>
      )}
    </ScrollArea>
  );

  return (
    <SplitSurface tree={tree}>
      {selectedFile ? (
        <DiffView api={api} cwd={cwd} file={selectedFile} />
      ) : null}
    </SplitSurface>
  );
}

function FileView({ api, path }: { api: omoApi; path: string }) {
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
    setContent(null);
    api.fs
      .read(path)
      .then((result) => setContent(result.content ?? result.error ?? ""));
  }, [api, path]);

  return content === null ? null : (
    <ScrollArea className="h-full">
      <DiffFile
        className="p-2 text-xs"
        file={{ contents: content, name: baseName(path) }}
        options={options}
      />
    </ScrollArea>
  );
}

function DiffView({
  api,
  cwd,
  file,
}: {
  api: omoApi;
  cwd: string;
  file: string;
}) {
  const { resolvedTheme } = useTheme();
  const [text, setText] = useState("");
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
    setText("");
    api.git.diff(cwd, file).then(setText);
  }, [api, cwd, file]);

  return (
    <ScrollArea className="h-full">
      <PatchDiff className="p-2 text-xs" options={options} patch={text} />
    </ScrollArea>
  );
}
