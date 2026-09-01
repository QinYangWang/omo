import { useEffect, useRef, useState } from "react";
import { Globe, TerminalSquare, FolderOpen, GitCompare, X, ChevronRight, ChevronDown, File, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type Surface = "browser" | "terminal" | "files" | "review";

const surfaces: { id: Surface; icon: typeof Globe; label: string; desc: string }[] = [
  { id: "browser", icon: Globe, label: "Browser", desc: "Open a local app or URL" },
  { id: "terminal", icon: TerminalSquare, label: "Terminal", desc: "Start a shell in this workspace" },
  { id: "files", icon: FolderOpen, label: "Files", desc: "Browse and read workspace files" },
  { id: "review", icon: GitCompare, label: "Review", desc: "Review file changes" },
];

export function RightPanel({
  surface,
  onSelect,
  onClose,
}: {
  surface: Surface | null;
  onSelect: (s: Surface) => void;
  onClose: () => void;
  full?: boolean;
}) {
  if (!surface) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-[#181818] p-6 pt-12">
        <div className="text-center">
          <div className="text-sm font-medium">Open a surface</div>
          <div className="text-xs text-muted-foreground">Choose what to show in the right panel</div>
        </div>
        <div className="grid w-full grid-cols-2 gap-3">
          {surfaces.map(({ id, icon: Icon, label, desc }) => (
            <button
              key={id}
              onClick={() => onSelect(id)}
              className="flex min-h-28 flex-col gap-1 rounded-lg border border-white/[0.06] bg-[#202020] p-4 text-left hover:bg-[#252525]"
            >
              <Icon className="size-4" />
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col bg-[#181818] pt-10">
      <Tabs value={surface} onValueChange={(v) => onSelect(v as Surface)} className="flex h-full flex-col">
        <div className="flex items-center border-b pr-1">
          <TabsList variant="underline" className="flex-1">
            {surfaces.map(({ id, icon: Icon, label }) => (
              <TabsTrigger key={id} value={id} className="gap-1.5">
                <Icon className="size-3.5" /> {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button variant="ghost" size="icon" aria-label="Close panel" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <TabsContent value="browser" className="min-h-0 flex-1 p-2">
          <BrowserSurface />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 flex-1 p-2">
          <TerminalSurface />
        </TabsContent>
        <TabsContent value="files" className="min-h-0 flex-1">
          <FilesSurface />
        </TabsContent>
        <TabsContent value="review" className="min-h-0 flex-1">
          <ReviewSurface />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BrowserSurface() {
  const [url, setUrl] = useState("http://localhost:5173");
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="flex h-full flex-col gap-2">
      <input
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (ref.current as any)?.loadURL?.(url);
        }}
      />
      <webview ref={ref as any} src={url} className="min-h-0 flex-1 rounded-md border" />
    </div>
  );
}

function TerminalSurface() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new XTerm({
      theme: { background: "#1a1a1a", foreground: "#d4d4d4" },
      fontSize: 13,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    window.omo.term.create();
    const off = window.omo.term.onData((d) => term.write(d));
    term.onData((d) => window.omo.term.input(d));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(ref.current!);
    return () => {
      off();
      ro.disconnect();
      term.dispose();
    };
  }, []);
  return <div ref={ref} className="h-full overflow-hidden rounded-md bg-background" />;
}

type FNode = { name: string; path: string; dir: boolean; children?: FNode[]; open?: boolean };

function FilesSurface() {
  const [root, setRoot] = useState<FNode[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    window.omo.cwd().then(async (cwd) => {
      setRootPath(cwd);
      const entries = await window.omo.fs.list(cwd);
      setRoot(entries.map((e) => ({ ...e, path: `${cwd}/${e.name}` })));
    });
  }, []);

  const toggle = async (node: FNode) => {
    if (!node.dir) {
      const r = await window.omo.fs.read(node.path);
      setFile({ path: node.path, content: r.content ?? r.error ?? "" });
      return;
    }
    if (!node.children) {
      const entries = await window.omo.fs.list(node.path);
      node.children = entries.map((e) => ({ ...e, path: `${node.path}/${e.name}` }));
    }
    node.open = !node.open;
    setRoot([...root]);
  };

  const renderNodes = (nodes: FNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.path}>
        <button
          onClick={() => toggle(n)}
          className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-sm hover:bg-accent"
          style={{ paddingLeft: depth * 14 + 6 }}
        >
          {n.dir ? (
            n.open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
          ) : (
            <span className="w-3.5" />
          )}
          {n.dir ? <Folder className="size-3.5" /> : <File className="size-3.5" />}
          <span className="truncate">{n.name}</span>
        </button>
        {n.dir && n.open && n.children && renderNodes(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className={file ? "h-1/3 border-b" : "flex-1"}>
        <div className="p-1">{renderNodes(root, 0)}</div>
      </ScrollArea>
      {file && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
            <span className="truncate">{file.path.replace(rootPath + "/", "")}</span>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setFile(null)}>
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <pre className="p-2 text-xs leading-relaxed">{file.content}</pre>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function ReviewSurface() {
  const [status, setStatus] = useState<{ file: string; xy: string }[]>([]);
  const [diff, setDiff] = useState<{ file: string; text: string } | null>(null);
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    window.omo.cwd().then(async (c) => {
      setCwd(c);
      const out = await window.omo.git.status(c);
      setStatus(
        out
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ xy: l.slice(0, 2), file: l.slice(3) }))
      );
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className={diff ? "h-1/3 border-b" : "flex-1"}>
        <ScrollArea className="h-full">
          <div className="p-1">
            {status.length === 0 && <p className="p-2 text-sm text-muted-foreground">无变更</p>}
            {status.map((s) => (
              <button
                key={s.file}
                onClick={async () =>
                  setDiff({ file: s.file, text: await window.omo.git.diff(cwd, s.file) })
                }
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              >
                <span className="w-6 font-mono text-xs text-muted-foreground">{s.xy.trim() || "?"}</span>
                <span className="truncate">{s.file}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      {diff && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
            <span className="truncate">{diff.file}</span>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setDiff(null)}>
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <pre className="p-2 text-xs leading-relaxed">
              {diff.text.split("\n").map((l, i) => (
                <span
                  key={i}
                  className={
                    l.startsWith("+")
                      ? "block text-emerald-400"
                      : l.startsWith("-")
                        ? "block text-red-400"
                        : l.startsWith("@@")
                          ? "block text-blue-400"
                          : "block"
                  }
                >
                  {l}
                </span>
              ))}
            </pre>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
