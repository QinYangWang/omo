import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  FileIcon,
  Folder01Icon,
  PiIcon,
  TerminalIcon,
  Wrench01Icon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import {
  File as DiffFile,
  FileDiff as DiffFileView,
} from "@pierre/diffs/react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
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
  kind: "browser" | "context" | "files" | "review" | "terminal";
}

const pathSeparatorPattern = /[\\/]/;
const diffPathPrefixPattern = /^[ab]\//;
const browserSchemePattern = /^[a-z][a-z\d+.-]*:/i;
const BROWSER_DEFAULT_URL = "https://pi.dev";
const baseName = (path: string) =>
  path.split(pathSeparatorPattern).pop() ?? path;
const normalizeDiffPath = (path: string) =>
  path.replaceAll("\\", "/").replace(diffPathPrefixPattern, "");
const joinPath = (parent: string, child: string) => `${parent}/${child}`;

export function Workspace({
  cwd,
  serverId,
  sessionId,
  sessionPath,
  terminalKey,
}: {
  cwd?: string;
  serverId?: string;
  sessionId: string;
  sessionPath?: string;
  terminalKey: string;
}) {
  const { t } = useI18n();
  const api = getServerApi(serverId);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "files", kind: "files" },
    { id: "review", kind: "review" },
    { id: "context", kind: "context" },
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
    if (tab.kind === "context") {
      return t("surface_context");
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
    <div className="flex h-full w-full flex-col bg-background">
      <Tabs className="contents" onValueChange={setActiveTab} value={activeTab}>
        <div className="flex h-12 shrink-0 items-center gap-1 border-border border-b bg-background px-2">
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
                    className="ms-1 shrink-0"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab);
                    }}
                    render={<span />}
                    size="icon-xs"
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
                <HugeiconsIcon icon={PiIcon} />
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
            {tab.kind === "context" ? (
              <ContextSurface
                active={activeTab === tab.id}
                api={api}
                cwd={projectCwd}
                sessionId={sessionId}
                sessionPath={sessionPath}
              />
            ) : null}
            {tab.kind === "terminal" ? (
              <TerminalSurface
                api={api}
                cwd={projectCwd}
                terminalKey={`${terminalKey}:${tab.id}`}
              />
            ) : null}
            {tab.kind === "browser" ? (
              <BrowserSurface
                api={api}
                native={
                  serverId === "local" &&
                  !!window.omoSecure &&
                  !window.__OMO_SERVER_URL__
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const formatTokenCount = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);

const sourcePath = (source: unknown): string => {
  if (typeof source !== "object" || source === null) {
    return "";
  }
  const record = source as Record<string, unknown>;
  if (typeof record.path === "string") {
    return record.path;
  }
  return typeof record.source === "string" ? record.source : "";
};

function ContextSection({
  children,
  count,
  defaultOpen = false,
  title,
}: {
  children: React.ReactNode;
  count?: number;
  defaultOpen?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <section className="overflow-hidden rounded-lg border bg-background">
        <CollapsibleTrigger
          className="flex h-10 w-full items-center gap-2 px-3 text-left font-medium text-sm hover:bg-muted/50"
          render={<Button type="button" variant="ghost" />}
        >
          <HugeiconsIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            icon={ArrowRight01Icon}
          />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count === undefined ? null : (
            <Badge variant="secondary">{count}</Badge>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t p-3">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function ContextSurface({
  active,
  api,
  cwd,
  sessionId,
  sessionPath,
}: {
  active: boolean;
  api: omoApi;
  cwd: string;
  sessionId: string;
  sessionPath?: string;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState<PiContextDetails>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!(active && cwd && sessionId)) {
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await api.pi.contextDetails(sessionId, cwd, sessionPath);
        if (!disposed) {
          setDetails(result);
          setError("");
        }
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    refresh().catch(() => undefined);
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, api, cwd, sessionId, sessionPath]);

  if (!(cwd && sessionId)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
        {t("context_empty")}
      </div>
    );
  }
  if (!(details || error)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!details) {
    return (
      <div className="p-4 text-destructive text-sm">
        {t("context_load_error", { error })}
      </div>
    );
  }

  const usage = details.contextUsage;
  const percent = usage?.percent;
  const resourcesCount =
    details.resources.contextFiles.length +
    details.resources.skills.length +
    details.resources.appendSystemPrompt.length;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
        {error ? (
          <p className="text-destructive text-xs">
            {t("context_load_error", { error })}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <div className="col-span-2 rounded-lg border bg-muted/20 p-3 lg:col-span-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t("context_usage")}
              </span>
              <span className="font-medium tabular-nums">
                {percent === null || percent === undefined
                  ? "—"
                  : `${percent.toFixed(1)}%`}
              </span>
            </div>
            <Progress className="mt-2" value={percent ?? 0}>
              <ProgressTrack className="h-1.5">
                <ProgressIndicator />
              </ProgressTrack>
            </Progress>
            <p className="mt-2 text-muted-foreground text-xs tabular-nums">
              {formatTokenCount(usage?.tokens)} /{" "}
              {formatTokenCount(usage?.contextWindow)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-muted-foreground text-xs">{t("context_cost")}</p>
            <p className="mt-2 font-semibold text-lg tabular-nums">
              ${details.stats.cost.toFixed(4)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-muted-foreground text-xs">
              {t("context_total_tokens")}
            </p>
            <p className="mt-2 font-semibold text-lg tabular-nums">
              {formatTokenCount(details.stats.tokens.total)}
            </p>
          </div>
        </div>

        <ContextSection defaultOpen title={t("context_prompt")}>
          <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
            {details.systemPrompt}
          </pre>
        </ContextSection>

        <ContextSection count={details.tools.length} title={t("context_tools")}>
          <div className="flex flex-col divide-y">
            {details.tools.map((tool) => (
              <Collapsible key={tool.name}>
                <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-2 py-2 text-left">
                  <HugeiconsIcon
                    className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
                    icon={ArrowRight01Icon}
                  />
                  <span className="font-mono text-xs">{tool.name}</span>
                  <Badge variant={tool.active ? "outline" : "secondary"}>
                    {tool.active ? "active" : "inactive"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                    {sourcePath(tool.source)}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-2 pb-3 pl-5 text-xs">
                    <p className="whitespace-pre-wrap text-muted-foreground leading-5">
                      {tool.description}
                    </p>
                    {tool.promptGuidelines?.length ? (
                      <pre className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono">
                        {tool.promptGuidelines.join("\n")}
                      </pre>
                    ) : null}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono">
                      {JSON.stringify(tool.parameters, null, 2)}
                    </pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </ContextSection>

        {details.injectedMessages.length ? (
          <ContextSection
            count={details.injectedMessages.length}
            title={t("context_messages")}
          >
            <div className="flex flex-col gap-2">
              {details.injectedMessages.map((message) => (
                <div className="rounded-md bg-muted/50 p-2" key={message.id}>
                  <p className="mb-1 font-medium font-mono text-xs">
                    {message.customType}
                  </p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5">
                    {typeof message.content === "string"
                      ? message.content
                      : JSON.stringify(message.content, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </ContextSection>
        ) : null}

        <ContextSection count={resourcesCount} title={t("context_resources")}>
          <div className="space-y-4 text-xs">
            <div>
              <h4 className="mb-2 font-medium">{t("context_files")}</h4>
              {details.resources.contextFiles.map((file) => (
                <ContextResource
                  content={file.content}
                  key={file.path}
                  path={file.path}
                />
              ))}
            </div>
            <div>
              <h4 className="mb-2 font-medium">{t("context_injected")}</h4>
              {details.resources.appendSystemPrompt.map((item) => (
                <ContextResource
                  content={item.content}
                  key={`${item.path ?? "inline"}:${item.content}`}
                  path={item.path ?? "inline"}
                />
              ))}
            </div>
            <div>
              <h4 className="mb-2 font-medium">{t("context_skills")}</h4>
              <div className="flex flex-col gap-1">
                {details.resources.skills.map((skill) => (
                  <div
                    className="rounded-md bg-muted/40 p-2"
                    key={skill.filePath}
                  >
                    <p className="font-medium">{skill.name}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {skill.description}
                    </p>
                    <p className="mt-1 truncate font-mono text-muted-foreground">
                      {skill.filePath}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ContextSection>

        <ContextSection
          count={details.extensions.length}
          title={t("context_extensions")}
        >
          <div className="flex flex-col gap-2 text-xs">
            {details.extensions.map((extension) => (
              <div className="rounded-md bg-muted/40 p-2" key={extension.path}>
                <div className="flex items-center gap-2">
                  <HugeiconsIcon className="size-3.5" icon={Wrench01Icon} />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {extension.path}
                  </span>
                  {extension.hidden ? (
                    <Badge variant="secondary">hidden</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {[
                    ...extension.tools,
                    ...extension.commands.map((name) => `/${name}`),
                  ].join(", ") || extension.events.join(", ")}
                </p>
              </div>
            ))}
          </div>
        </ContextSection>
      </div>
    </ScrollArea>
  );
}

function ContextResource({ content, path }: { content: string; path: string }) {
  return (
    <Collapsible>
      <div className="border-t first:border-t-0">
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 py-1.5 text-left">
          <HugeiconsIcon
            className="size-3 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
            icon={ArrowRight01Icon}
          />
          <span className="truncate font-mono">{path}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mb-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono leading-5">
            {content}
          </pre>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
    <div className="flex h-full min-w-0 bg-background">
      <aside className="w-64 shrink-0 border-sidebar-border border-r bg-sidebar">
        {tree}
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function BrowserSurface({ api, native }: { api: omoApi; native: boolean }) {
  return native ? <NativeBrowserSurface /> : <ServerBrowserSurface api={api} />;
}

function NativeBrowserSurface() {
  const [url, setUrl] = useState(BROWSER_DEFAULT_URL);
  const ref = useRef<WebviewElement>(null);
  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        aria-label="URL"
        className="h-8"
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            ref.current?.loadURL(url);
          }
        }}
        value={url}
      />
      <webview
        className="min-h-0 flex-1 rounded-lg border"
        ref={ref}
        src={BROWSER_DEFAULT_URL}
      />
    </div>
  );
}

function ServerBrowserSurface({ api }: { api: omoApi }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(BROWSER_DEFAULT_URL);
  const [frameUrl, setFrameUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const browserIdRef = useRef<{ value?: string }>({});

  useEffect(() => {
    let active = true;
    api.browser
      .open(BROWSER_DEFAULT_URL)
      .then((page) => {
        if (!active) {
          return;
        }
        browserIdRef.current.value = page.browserId;
        setFrameUrl(page.url);
        setError("");
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
      const { value: browserId } = browserIdRef.current;
      browserIdRef.current.value = undefined;
      if (browserId) {
        api.browser.close(browserId).catch(() => undefined);
      }
    };
  }, [api]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const { data } = event;
      if (
        typeof data !== "object" ||
        data === null ||
        !("browserId" in data) ||
        !("type" in data) ||
        !("url" in data) ||
        data.browserId !== browserIdRef.current.value ||
        data.type !== "omo-browser-location" ||
        typeof data.url !== "string"
      ) {
        return;
      }
      setUrl(data.url);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const navigate = (nextUrl: string) => {
    const value = nextUrl.trim();
    if (!value) {
      return;
    }
    const target = browserSchemePattern.test(value)
      ? value
      : `https://${value}`;
    setLoading(true);
    setError("");
    const { value: browserId } = browserIdRef.current;
    const request = browserId
      ? api.browser.navigate(browserId, target)
      : api.browser.open(target);
    request
      .then((page) => {
        browserIdRef.current.value = page.browserId;
        setUrl(target);
        setFrameUrl(page.url);
      })
      .catch((cause: unknown) => {
        setLoading(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        aria-label={t("browser_address")}
        className="h-8"
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            navigate(url);
          }
        }}
        placeholder={t("browser_address")}
        value={url}
      />
      {error ? (
        <p className="px-1 text-destructive text-xs">
          {t("browser_error", { error })}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {loading && frameUrl ? (
          <div className="pointer-events-none absolute top-2 right-3 z-10 rounded bg-background/80 px-2 py-1 text-muted-foreground text-xs">
            {t("browser_loading")}
          </div>
        ) : null}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: iframe load events update the browser status indicator. */}
        <iframe
          aria-label={t("surface_browser")}
          className="h-full w-full rounded-lg border bg-background"
          onLoad={() => setLoading(false)}
          ref={frameRef}
          referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-presentation allow-scripts"
          src={frameUrl || "about:blank"}
          title={t("surface_browser")}
        />
      </div>
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
      fontFamily:
        styles.getPropertyValue("--font-mono") ||
        styles.getPropertyValue("--font-geist-mono") ||
        "monospace",
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
            "h-7 w-full justify-start gap-1 rounded-lg px-1.5 font-normal text-sidebar-foreground text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            node.path === activePath &&
              "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
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

  return <div className="p-2">{renderNodes(nodes, 0)}</div>;
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
      <div className="p-2">
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
        <DiffView api={api} cwd={cwd} file={selectedFile} key={selectedFile} />
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
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      disableFileHeader: true,
      overflow: "wrap" as const,
      themeType: resolvedTheme,
    }),
    [resolvedTheme]
  );
  const parsedFile = useMemo<FileDiffMetadata | null>(() => {
    if (!text.trim()) {
      return null;
    }
    try {
      const files = parsePatchFiles(text)
        .flatMap((patch) => patch.files)
        .filter((candidate) => candidate.hunks.length > 0);
      const normalizedFile = normalizeDiffPath(file);
      return (
        files.find(
          (candidate) =>
            normalizeDiffPath(candidate.name) === normalizedFile ||
            (candidate.prevName !== undefined &&
              normalizeDiffPath(candidate.prevName) === normalizedFile)
        ) ?? (files.length === 1 ? files[0] : null)
      );
    } catch {
      return null;
    }
  }, [file, text]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setText("");
    api.git
      .diff(cwd, file)
      .then((next) => {
        if (active) {
          setText(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setText("");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, cwd, file]);

  if (loading) {
    return (
      <div className="p-4 text-muted-foreground text-sm">
        {t("diff_loading")}
      </div>
    );
  }
  if (!parsedFile) {
    return (
      <div className="p-4 text-muted-foreground text-sm">
        {t("diff_unavailable")}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <DiffFileView
        className="p-2 text-xs"
        fileDiff={parsedFile}
        options={options}
      />
    </ScrollArea>
  );
}
