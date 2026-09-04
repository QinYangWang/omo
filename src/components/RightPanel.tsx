import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  GitCompare,
  Globe,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { getServerApi } from "@/lib/servers";
import { normalizeColorToHex } from "@/lib/theme-tokens";
import "@xterm/xterm/css/xterm.css";

export type Surface = "browser" | "terminal" | "files" | "review";

const diffLines = (text: string) => {
  const occurrences = new Map<string, number>();
  return text.split("\n").map((line) => {
    const occurrence = occurrences.get(line) ?? 0;
    occurrences.set(line, occurrence + 1);
    return { key: `${line}-${occurrence}`, line };
  });
};

const diffLineClass = (line: string) => {
  if (line.startsWith("+")) {
    return "block text-success";
  }
  if (line.startsWith("-")) {
    return "block text-destructive";
  }
  if (line.startsWith("@@")) {
    return "block text-info";
  }
  return "block";
};

const surfaceDefs = () => {
  const { t } = useI18n();
  return [
    {
      desc: t("surface_browser_desc"),
      icon: Globe,
      id: "browser",
      label: t("surface_browser"),
    },
    {
      desc: t("surface_terminal_desc"),
      icon: TerminalSquare,
      id: "terminal",
      label: t("surface_terminal"),
    },
    {
      desc: t("surface_files_desc"),
      icon: FolderOpen,
      id: "files",
      label: t("surface_files"),
    },
    {
      desc: t("surface_review_desc"),
      icon: GitCompare,
      id: "review",
      label: t("surface_review"),
    },
  ] as { id: Surface; icon: typeof Globe; label: string; desc: string }[];
};

export function RightPanel({
  surface,
  onSelect,
  serverId,
}: {
  surface: Surface | null;
  onSelect: (s: Surface) => void;
  serverId?: string;
  full?: boolean;
}) {
  const { t } = useI18n();
  const api = getServerApi(serverId);
  const surfaces = surfaceDefs();
  if (!surface) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-panel p-6 pt-12">
        <div className="text-center">
          <div className="font-medium text-sm">{t("open_surface")}</div>
          <div className="text-muted-foreground text-xs">
            {t("open_surface_desc")}
          </div>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-0.5">
          {surfaces.map(({ id, icon: Icon, label, desc }) => (
            <Button
              className="h-auto justify-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
              key={id}
              onClick={() => onSelect(id)}
              variant="ghost"
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium text-sm">{label}</span>
                <span className="block truncate text-muted-foreground text-xs">
                  {desc}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col bg-panel pt-10">
      <Tabs
        className="flex h-full flex-col"
        onValueChange={(v) => onSelect(v as Surface)}
        value={surface}
      >
        <div className="flex items-center border-b pr-1">
          <TabsList className="flex-1" variant="line">
            {surfaces.map(({ id, icon: Icon, label }) => (
              <TabsTrigger className="gap-1.5" key={id} value={id}>
                <Icon className="size-3.5" /> {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent className="min-h-0 flex-1 p-2" value="browser">
          <BrowserSurface />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 p-2" value="terminal">
          <TerminalSurface api={api} key={serverId} />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1" value="files">
          <FilesSurface api={api} key={serverId} />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1" value="review">
          <ReviewSurface api={api} key={serverId} />
        </TabsContent>
      </Tabs>
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
    <ChevronDown className="size-3.5" />
  ) : (
    <ChevronRight className="size-3.5" />
  );
}

function FilesSurface({ api }: { api: omoApi }) {
  const [root, setRoot] = useState<FNode[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [file, setFile] = useState<{ path: string; content: string } | null>(
    null
  );

  useEffect(() => {
    api.cwd().then(async (cwd) => {
      setRootPath(cwd);
      const entries = await api.fs.list(cwd);
      setRoot(entries.map((e) => ({ ...e, path: `${cwd}/${e.name}` })));
    });
  }, [api]);

  const toggle = async (node: FNode) => {
    if (!node.dir) {
      const r = await api.fs.read(node.path);
      setFile({ content: r.content ?? r.error ?? "", path: node.path });
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

  const renderNodes = (nodes: FNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.path}>
        <Button
          className="h-auto w-full justify-start gap-1 rounded px-1.5 py-0.5 font-normal text-sm"
          onClick={() => toggle(n)}
          style={{ paddingLeft: depth * 14 + 6 }}
          variant="ghost"
        >
          <FileNodeToggle node={n} />
          {n.dir ? (
            <Folder className="size-3.5" />
          ) : (
            <File className="size-3.5" />
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
      <ScrollArea className={file ? "h-1/3 border-b" : "flex-1"}>
        <div className="p-1">{renderNodes(root, 0)}</div>
      </ScrollArea>
      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-2 py-1 text-muted-foreground text-xs">
            <span className="truncate">
              {file.path.replace(`${rootPath}/`, "")}
            </span>
            <Button
              className="size-6"
              onClick={() => setFile(null)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <pre className="p-2 text-xs leading-relaxed">{file.content}</pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}

function ReviewSurface({ api }: { api: omoApi }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ file: string; xy: string }[]>([]);
  const [diff, setDiff] = useState<{ file: string; text: string } | null>(null);
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
    <div className="flex h-full flex-col">
      <div className={diff ? "h-1/3 border-b" : "flex-1"}>
        <ScrollArea className="h-full">
          <div className="p-1">
            {status.length === 0 && (
              <p className="p-2 text-muted-foreground text-sm">
                {t("no_changes")}
              </p>
            )}
            {status.map((s) => (
              <Button
                className="h-auto w-full justify-start gap-2 rounded px-2 py-1 font-normal text-sm"
                key={s.file}
                onClick={async () =>
                  setDiff({
                    file: s.file,
                    text: await api.git.diff(cwd, s.file),
                  })
                }
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
      </div>
      {diff ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-2 py-1 text-muted-foreground text-xs">
            <span className="truncate">{diff.file}</span>
            <Button
              className="size-6"
              onClick={() => setDiff(null)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <pre className="p-2 text-xs leading-relaxed">
              {diffLines(diff.text).map(({ key, line }) => (
                <span className={diffLineClass(line)} key={key}>
                  {line}
                </span>
              ))}
            </pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}
