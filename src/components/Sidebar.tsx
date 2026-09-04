import {
  ChevronRight,
  Folder,
  Import,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useState } from "react";
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
import { type I18nKey, useI18n } from "@/lib/i18n";
import { getServerApi, useServers } from "@/lib/servers";
import { cn } from "@/lib/utils";

const COLLAPSED_SESSION_LIMIT = 5;

function getVisibleSessions(
  sessions: PiSession[],
  activeSession: string | null,
  expanded: boolean
): PiSession[] {
  if (expanded) {
    return sessions;
  }
  const visibleSessions = sessions.slice(0, COLLAPSED_SESSION_LIMIT);
  const activeProjectSession = sessions.find(
    (session) => activeSession === session.path || activeSession === session.id
  );
  if (activeProjectSession && !visibleSessions.includes(activeProjectSession)) {
    visibleSessions.push(activeProjectSession);
  }
  return visibleSessions;
}

export function Sidebar({
  projects,
  sessions,
  activeSession,
  onRequestAddProject,
  onNewSession,
  onSelectSession,
  onImport,
  onOpenSettings,
}: {
  projects: Project[];
  sessions: Record<string, PiSession[]>;
  activeSession: string | null;
  onRequestAddProject: () => void;
  onNewSession: (project: Project) => void;
  onSelectSession: (project: Project, session: PiSession) => void;
  onImport: (project: Project, path: string) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const servers = useServers();
  const [importProject, setImportProject] = useState<Project | null>(null);
  const [projectSessions, setProjectSessions] = useState<PiSession[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<
    Record<string, boolean>
  >({});
  const [expandedSessionLists, setExpandedSessionLists] = useState<
    Record<string, boolean>
  >({});
  const multiServer = servers.length > 1;
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;
  const serverName = (serverId: string) => {
    const server = servers.find((item) => item.id === serverId);
    if (!server) {
      return serverId;
    }
    if (server.kind === "remote") {
      return server.name;
    }
    return t((hosted ? "server_hosted" : "server_local") as I18nKey);
  };

  const openImport = async (project: Project) => {
    setImportProject(project);
    setProjectSessions(
      await getServerApi(project.serverId).sessions.list(project.cwd)
    );
  };

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
          onClick={onRequestAddProject}
          size="icon"
          variant="ghost"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-4">
          {projects.length === 0 && (
            <Button
              className="h-auto w-full flex-col items-start gap-2 rounded-md px-2 py-3 font-normal text-muted-foreground text-sm"
              onClick={onRequestAddProject}
              variant="ghost"
            >
              <Folder className="size-4" /> {t("add_project")}
            </Button>
          )}
          {projects.map((project) => {
            const projectSessionItems = sessions[project.id] ?? [];
            const sessionListExpanded =
              expandedSessionLists[project.id] ?? false;
            const visibleSessions = getVisibleSessions(
              projectSessionItems,
              activeSession,
              sessionListExpanded
            );

            return (
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
                      {multiServer ? (
                        <span className="shrink-0 rounded-sm border border-border px-1 py-px text-[10px] text-muted-foreground">
                          {serverName(project.serverId)}
                        </span>
                      ) : null}
                    </CollapsibleTrigger>
                    <Button
                      aria-label={t("import_session")}
                      className="size-6 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-60"
                      onClick={() => openImport(project)}
                      size="icon"
                      title={t("import_session")}
                      variant="ghost"
                    >
                      <Import className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={t("new_session")}
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
                      {visibleSessions.map((session) => (
                        <Button
                          className={cn(
                            "h-auto w-full justify-start truncate rounded-md px-2 py-1.5 font-normal text-muted-foreground text-sm hover:text-foreground",
                            (activeSession === session.path ||
                              activeSession === session.id) &&
                              "bg-accent text-foreground"
                          )}
                          key={session.path}
                          onClick={() => onSelectSession(project, session)}
                          title={session.name || session.firstMessage}
                          variant="ghost"
                        >
                          <span className="truncate">
                            {session.name ||
                              session.firstMessage ||
                              t("untitled")}
                          </span>
                        </Button>
                      ))}
                      {projectSessionItems.length > COLLAPSED_SESSION_LIMIT ? (
                        <Button
                          className="h-7 w-full justify-start px-2 font-normal text-muted-foreground text-xs"
                          onClick={() =>
                            setExpandedSessionLists((current) => ({
                              ...current,
                              [project.id]: !sessionListExpanded,
                            }))
                          }
                          variant="ghost"
                        >
                          {sessionListExpanded
                            ? t("show_fewer_sessions")
                            : t("show_all_sessions", {
                                count: String(projectSessionItems.length),
                              })}
                        </Button>
                      ) : null}
                    </div>
                  </CollapsibleContent>
                </section>
              </Collapsible>
            );
          })}
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
                <Button
                  className="h-auto w-full min-w-0 flex-col items-start gap-0 rounded-md px-3 py-2 font-normal"
                  key={session.path}
                  onClick={async () => {
                    if (!importProject) {
                      return;
                    }
                    await onImport(importProject, session.path);
                    setImportProject(null);
                  }}
                  variant="ghost"
                >
                  <div className="w-full min-w-0 truncate text-sm">
                    {session.name || session.firstMessage || t("untitled")}
                  </div>
                  <div className="w-full min-w-0 truncate text-muted-foreground text-xs">
                    {session.cwd} · {session.messageCount} messages
                  </div>
                </Button>
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
