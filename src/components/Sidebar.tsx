import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, Import, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";

type DirectoryNode = { name: string; path: string };

const fs = {
  list: async (dir: string) => {
    const entries = await omo.fs.list(dir);
    return entries.map((entry) => ({ ...entry, path: `${dir}/${entry.name}` }));
  },
};

function DirectoryPicker({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [root, setRoot] = useState("");
  const [nodes, setNodes] = useState<DirectoryNode[]>([]);
  const [stack, setStack] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentPath = stack[stack.length - 1] || root;

  const load = async (path?: string) => {
    setLoading(true);
    setError("");
    try {
      const target = path || root;
      const entries = await fs.list(target);
      setNodes(entries.filter((item) => item.dir));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    omo.cwd().then(async (path) => {
      setRoot(path);
      setNodes((await fs.list(path)).filter((item) => item.dir));
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={!stack.length} onClick={() => { const next = stack.slice(0, -1); setStack(next); void load(next[next.length - 1]); }}>Back</Button>
        <div className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{currentPath || "…"}</div>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <ScrollArea className="h-72 rounded-md border border-border">
        <div className="p-1">
          {loading && <p className="p-2 text-sm text-muted-foreground">Loading…</p>}
          {!loading && nodes.map((node) => (
            <button
              key={node.path}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => { setStack((items) => [...items, node.path]); void load(node.path); }}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </button>
          ))}
          {!loading && nodes.length === 0 && <p className="p-2 text-sm text-muted-foreground">No subdirectories</p>}
        </div>
      </ScrollArea>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={!currentPath || loading} onClick={() => onSelect(currentPath)}>Select this directory</Button>
      </div>
    </div>
  );
}

export function Sidebar({
  projects,
  sessions,
  activeSession,
  onAddProject,
  onNewSession,
  onSelectSession,
  onImport,
  onOpenSettings,
}: {
  projects: Project[];
  sessions: Record<string, PiSession[]>;
  activeSession: string | null;
  onAddProject: (path: string) => Promise<Project | null | undefined>;
  onNewSession: (project: Project) => void;
  onSelectSession: (project: Project, session: PiSession) => void;
  onImport: (project: Project, path: string) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const [importProject, setImportProject] = useState<Project | null>(null);
  const [projectSessions, setProjectSessions] = useState<PiSession[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [projectSource, setProjectSource] = useState<"local" | "remote">("remote");
  const canLocal = typeof window.omo?.fs?.list === "function" && !localStorage.getItem("omo:server-url");
  const source = canLocal ? projectSource : "remote";

  useEffect(() => {
    if (source === "local" && !canLocal) setProjectSource("remote");
  }, [canLocal, source]);

  const openImport = async (project: Project) => {
    setImportProject(project);
    setProjectSessions(await omo.sessions.list(project.cwd));
  };

  const addFromPath = async (path: string) => {
    await onAddProject(path);
    setAddOpen(false);
  };

  const pickLocalDirectory = async () => {
    const path = await omo.projects.pickDirectory();
    if (path) await addFromPath(path);
  };

  const currentPicker = useMemo(() => addOpen ? (
    source === "local" ? null : <DirectoryPicker key={source} onSelect={addFromPath} onCancel={() => setAddOpen(false)} />
  ) : null, [addOpen, source]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-2 pb-1">
        <Button variant="ghost" className="w-full justify-start gap-2 font-normal">
          <Search className="size-4" /> {t("search")}
        </Button>
      </div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
        <span>{t("projects")}</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label={t("add_project")} onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 px-2 pb-4">
          {projects.length === 0 && (
            <button className="w-full rounded-md px-2 py-3 text-left text-sm text-muted-foreground hover:bg-accent" onClick={() => setAddOpen(true)}>
              <Folder className="mb-2 size-4" /> {t("add_local_dir")}
            </button>
          )}
          {projects.map((project) => (
            <section key={project.id}>
              <div className="group flex h-8 items-center gap-2 px-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
                <Button variant="ghost" size="icon" className="size-6 opacity-60 hover:opacity-100" title={t("import_session")} onClick={() => openImport(project)}>
                  <Import className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 opacity-60 hover:opacity-100" title={t("new_session")} onClick={() => onNewSession(project)}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <div className="ml-5 border-l border-border pl-1">
                {(sessions[project.id] ?? []).map((session) => (
                  <button
                    key={session.path}
                    onClick={() => onSelectSession(project, session)}
                    className={cn(
                      "block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                      activeSession === session.path && "bg-accent text-foreground"
                    )}
                    title={session.name || session.firstMessage}
                  >
                    {session.name || session.firstMessage || t("untitled")}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
      <div className="p-2">
        <Button variant="ghost" size="icon" aria-label={t("settings")} onClick={onOpenSettings}>
          <Settings className="size-4" />
        </Button>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("add_project")}</DialogTitle>
            <DialogDescription>选择本地或远程服务器上的目录。</DialogDescription>
          </DialogHeader>
          {canLocal && (
            <div className="flex gap-1">
              {(["local", "remote"] as const).map((item) => (
                <Button key={item} variant={source === item ? "secondary" : "ghost"} size="sm" onClick={() => setProjectSource(item)}>
                  {item === "local" ? "Local" : "Remote"}
                </Button>
              ))}
            </div>
          )}
          {source === "local" ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-border p-4">
              <p className="text-sm text-muted-foreground">使用操作系统目录选择器选择本地项目目录。</p>
              <div className="flex gap-2">
                <Button onClick={pickLocalDirectory}>Choose directory</Button>
                <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              </div>
            </div>
          ) : currentPicker}
        </DialogContent>
      </Dialog>

      <Dialog open={!!importProject} onOpenChange={(open) => !open && setImportProject(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("import_title", { name: importProject?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("import_desc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-96">
            <div className="space-y-1 pr-2">
              {projectSessions.map((session) => (
                <button
                  key={session.path}
                  className="w-full rounded-md px-3 py-2 text-left hover:bg-accent"
                  onClick={async () => {
                    if (!importProject) return;
                    await onImport(importProject, session.path);
                    setImportProject(null);
                  }}
                >
                  <div className="truncate text-sm">{session.name || session.firstMessage || t("untitled")}</div>
                  <div className="truncate text-xs text-muted-foreground">{session.cwd} · {session.messageCount} messages</div>
                </button>
              ))}
              {projectSessions.length === 0 && <p className="p-2 text-sm text-muted-foreground">No sessions in this directory</p>}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
