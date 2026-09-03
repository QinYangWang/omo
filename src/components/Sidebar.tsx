import {
  ChevronRight,
  Folder,
  Import,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import { getRemoteConfig } from "@/lib/remote-api";
import { cn } from "@/lib/utils";

interface DirectoryNode {
  name: string;
  path: string;
}

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
  const currentPath = stack.at(-1) || root;

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
    omo
      .cwd()
      .then(async (path) => {
        setRoot(path);
        setNodes((await fs.list(path)).filter((item) => item.dir));
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          disabled={!stack.length}
          onClick={async () => {
            const next = stack.slice(0, -1);
            setStack(next);
            await load(next.at(-1));
          }}
          size="sm"
          variant="ghost"
        >
          Back
        </Button>
        <div className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
          {currentPath || "…"}
        </div>
      </div>
      {error ? <p className="text-red-400 text-sm">{error}</p> : null}
      <ScrollArea className="h-72 rounded-md border border-border">
        <div className="p-1">
          {loading ? (
            <p className="p-2 text-muted-foreground text-sm">Loading…</p>
          ) : null}
          {loading
            ? null
            : nodes.map((node) => (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  key={node.path}
                  onClick={async () => {
                    setStack((items) => [...items, node.path]);
                    await load(node.path);
                  }}
                  type="button"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </button>
              ))}
          {!loading && nodes.length === 0 ? (
            <p className="p-2 text-muted-foreground text-sm">
              No subdirectories
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={!currentPath || loading}
          onClick={() => onSelect(currentPath)}
        >
          Select this directory
        </Button>
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
  const [expandedProjects, setExpandedProjects] = useState<
    Record<string, boolean>
  >({});
  const [addOpen, setAddOpen] = useState(false);
  const [projectSource, setProjectSource] = useState<"local" | "remote">(
    "remote"
  );
  const canLocal =
    !!window.omoSecure &&
    typeof window.omo?.fs?.list === "function" &&
    !getRemoteConfig().url;
  const source = canLocal ? projectSource : "remote";

  useEffect(() => {
    if (source === "local" && !canLocal) {
      setProjectSource("remote");
    }
  }, [canLocal, source]);

  const openImport = async (project: Project) => {
    setImportProject(project);
    setProjectSessions(await omo.sessions.list(project.cwd));
  };

  const addFromPath = useCallback(
    async (path: string) => {
      await onAddProject(path);
      setAddOpen(false);
    },
    [onAddProject]
  );

  const pickLocalDirectory = async () => {
    const path = await omo.projects.pickDirectory();
    if (path) {
      await addFromPath(path);
    }
  };

  const currentPicker = useMemo(
    () =>
      addOpen && source === "remote" ? (
        <DirectoryPicker
          key={source}
          onCancel={() => setAddOpen(false)}
          onSelect={addFromPath}
        />
      ) : null,
    [addOpen, source, addFromPath]
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="px-2 pb-1">
        <Button
          className="w-full justify-start gap-2 font-normal"
          variant="ghost"
        >
          <Search className="size-4" /> {t("search")}
        </Button>
      </div>
      <div className="flex items-center justify-between px-4 py-2 text-muted-foreground text-xs">
        <span>{t("projects")}</span>
        <Button
          aria-label={t("add_project")}
          className="size-6"
          onClick={() => setAddOpen(true)}
          size="icon"
          variant="ghost"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-4">
          {projects.length === 0 && (
            <button
              className="w-full rounded-md px-2 py-3 text-left text-muted-foreground text-sm hover:bg-accent"
              onClick={() => setAddOpen(true)}
              type="button"
            >
              <Folder className="mb-2 size-4" /> {t("add_local_dir")}
            </button>
          )}
          {projects.map((project) => (
            <Collapsible
              key={project.id}
              onOpenChange={(open) =>
                setExpandedProjects((current) => ({
                  ...current,
                  [project.id]: open,
                }))
              }
              open={expandedProjects[project.id] ?? true}
            >
              <section>
                <div className="group flex h-8 items-center gap-2 px-2">
                  <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        (expandedProjects[project.id] ?? true) && "rotate-90"
                      )}
                    />
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium text-sm">
                      {project.name}
                    </span>
                  </CollapsibleTrigger>
                  <Button
                    className="size-6 opacity-60 hover:opacity-100"
                    onClick={() => openImport(project)}
                    size="icon"
                    title={t("import_session")}
                    variant="ghost"
                  >
                    <Import className="size-3.5" />
                  </Button>
                  <Button
                    className="size-6 opacity-60 hover:opacity-100"
                    onClick={() => onNewSession(project)}
                    size="icon"
                    title={t("new_session")}
                    variant="ghost"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                <CollapsibleContent>
                  <div className="ml-5 border-border border-l pl-1">
                    {(sessions[project.id] ?? []).map((session) => (
                      <button
                        className={cn(
                          "block w-full truncate rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground",
                          activeSession === session.path &&
                            "bg-accent text-foreground"
                        )}
                        key={session.path}
                        onClick={() => onSelectSession(project, session)}
                        title={session.name || session.firstMessage}
                        type="button"
                      >
                        {session.name || session.firstMessage || t("untitled")}
                      </button>
                    ))}
                  </div>
                </CollapsibleContent>
              </section>
            </Collapsible>
          ))}
        </div>
      </ScrollArea>
      <div className="p-2">
        <Button
          aria-label={t("settings")}
          onClick={onOpenSettings}
          size="icon"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>
      </div>

      <Dialog onOpenChange={setAddOpen} open={addOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("add_project")}</DialogTitle>
            <DialogDescription>
              选择本地或远程服务器上的目录。
            </DialogDescription>
          </DialogHeader>
          {canLocal ? (
            <div className="flex gap-1">
              {(["local", "remote"] as const).map((item) => (
                <Button
                  key={item}
                  onClick={() => setProjectSource(item)}
                  size="sm"
                  variant={source === item ? "secondary" : "ghost"}
                >
                  {item === "local" ? "Local" : "Remote"}
                </Button>
              ))}
            </div>
          ) : null}
          {source === "local" ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-border p-4">
              <p className="text-muted-foreground text-sm">
                使用操作系统目录选择器选择本地项目目录。
              </p>
              <div className="flex gap-2">
                <Button onClick={pickLocalDirectory}>Choose directory</Button>
                <Button onClick={() => setAddOpen(false)} variant="ghost">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            currentPicker
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setImportProject(null)}
        open={!!importProject}
      >
        <DialogContent className="min-w-0 max-w-xl">
          <DialogHeader className="min-w-0">
            <DialogTitle className="min-w-0 truncate pr-8">
              {t("import_title", { name: importProject?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("import_desc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-96 min-w-0">
            <div className="space-y-1 pr-2">
              {projectSessions.map((session) => (
                <button
                  className="flex w-full min-w-0 flex-col rounded-md px-3 py-2 text-left hover:bg-accent"
                  key={session.path}
                  onClick={async () => {
                    if (!importProject) {
                      return;
                    }
                    await onImport(importProject, session.path);
                    setImportProject(null);
                  }}
                  type="button"
                >
                  <div className="w-full min-w-0 truncate text-sm">
                    {session.name || session.firstMessage || t("untitled")}
                  </div>
                  <div className="w-full min-w-0 truncate text-muted-foreground text-xs">
                    {session.cwd} · {session.messageCount} messages
                  </div>
                </button>
              ))}
              {projectSessions.length === 0 && (
                <p className="p-2 text-muted-foreground text-sm">
                  No sessions in this directory
                </p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
