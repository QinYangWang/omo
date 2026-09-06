import {
  Add01Icon,
  AddCircleIcon,
  Archive01Icon,
  Folder01Icon,
  ImportIcon,
  PinIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import {
  sessionKey,
  setSessionPref,
  useSessionPrefs,
} from "@/lib/session-prefs";
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
  onNewSessionAny,
  onSelectSession,
  onImport,
  onOpenSettings,
}: {
  projects: Project[];
  sessions: Record<string, PiSession[]>;
  activeSession: string | null;
  onRequestAddProject: () => void;
  onNewSession: (project: Project) => void;
  onNewSessionAny: () => void;
  onSelectSession: (project: Project, session: PiSession) => void;
  onImport: (project: Project, path: string) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const servers = useServers();
  const prefs = useSessionPrefs();
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
      <div className="space-y-0.5 px-2 pb-1">
        <Button
          className="w-full justify-start gap-2 px-2 font-normal"
          disabled={projects.length === 0}
          onClick={onNewSessionAny}
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={AddCircleIcon} />{" "}
          {t("new_session")}
        </Button>
      </div>
      <div className="group/header flex items-center justify-between px-4 py-2 text-muted-foreground text-sm">
        <span>{t("projects")}</span>
        <Button
          aria-label={t("add_project")}
          className="size-6 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover/header:opacity-60"
          onClick={onRequestAddProject}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={Add01Icon} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-4">
          {projects.length === 0 && (
            <Button
              className="h-auto w-full flex-col items-start gap-2 rounded-md px-2 py-3 font-normal text-muted-foreground text-sm"
              onClick={onRequestAddProject}
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={Folder01Icon} />{" "}
              {t("add_project")}
            </Button>
          )}
          {projects.map((project) => {
            const decorated = (sessions[project.id] ?? []).flatMap(
              (session, index) => {
                const pref = prefs[sessionKey(project.serverId, session.path)];
                return pref?.archived
                  ? []
                  : [{ index, pinned: !!pref?.pinned, session }];
              }
            );
            decorated.sort((a, b) => {
              if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
              }
              return a.pinned
                ? b.session.created - a.session.created
                : a.index - b.index;
            });
            const projectSessionItems = decorated.map((item) => item.session);
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
                      <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        icon={Folder01Icon}
                      />
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
                      <HugeiconsIcon className="size-3.5" icon={ImportIcon} />
                    </Button>
                    <Button
                      aria-label={t("new_session")}
                      className="size-6 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-60"
                      onClick={() => onNewSession(project)}
                      size="icon"
                      title={t("new_session")}
                      variant="ghost"
                    >
                      <HugeiconsIcon className="size-3.5" icon={AddCircleIcon} />
                    </Button>
                  </div>
                  <CollapsibleContent>
                    <div className="pl-2">
                      {visibleSessions.map((session) => {
                        const key = sessionKey(project.serverId, session.path);
                        const pinned = !!prefs[key]?.pinned;
                        const isActive =
                          activeSession === session.path ||
                          activeSession === session.id;
                        const snapshot = {
                          project: project.name,
                          title:
                            session.name ||
                            session.firstMessage ||
                            t("untitled"),
                        };
                        return (
                          <Button
                            className={cn(
                              "group relative h-auto w-full justify-start rounded-md py-1.5 pr-2 pl-6 font-normal text-muted-foreground text-sm hover:text-foreground",
                              isActive && "bg-accent text-foreground"
                            )}
                            key={session.path}
                            onClick={() => onSelectSession(project, session)}
                            title={session.name || session.firstMessage}
                            variant="ghost"
                          >
                            <span
                              className={cn(
                                "truncate",
                                pinned && "group-hover:pr-6"
                              )}
                            >
                              {session.name ||
                                session.firstMessage ||
                                t("untitled")}
                            </span>
                            <span
                              className={cn(
                                "absolute right-1 flex items-center rounded-md pl-5 transition-opacity group-hover:bg-muted",
                                isActive ? "bg-accent" : "bg-sidebar",
                                pinned
                                  ? "opacity-100"
                                  : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                              )}
                            >
                              <Button
                                aria-label={t(
                                  pinned ? "unpin_session" : "pin_session"
                                )}
                                className={cn(
                                  "size-6",
                                  !pinned && "opacity-60 hover:opacity-100"
                                )}
                                nativeButton={false}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSessionPref(key, {
                                    ...snapshot,
                                    pinned: !pinned,
                                  });
                                }}
                                render={<span />}
                                size="icon"
                                title={t(
                                  pinned ? "unpin_session" : "pin_session"
                                )}
                                variant="ghost"
                              >
                                <HugeiconsIcon
                                  className={cn(
                                    "size-3.5",
                                    pinned && "fill-current"
                                  )}
                                  icon={PinIcon}
                                />
                              </Button>
                              <Button
                                aria-label={t("archive_session")}
                                className="size-6 opacity-60 hover:opacity-100"
                                nativeButton={false}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSessionPref(key, {
                                    ...snapshot,
                                    archived: true,
                                  });
                                }}
                                render={<span />}
                                size="icon"
                                title={t("archive_session")}
                                variant="ghost"
                              >
                                <HugeiconsIcon
                                  className="size-3.5"
                                  icon={Archive01Icon}
                                />
                              </Button>
                            </span>
                          </Button>
                        );
                      })}
                      {projectSessionItems.length > COLLAPSED_SESSION_LIMIT ? (
                        <Button
                          className="h-7 w-full justify-start pr-2 pl-6 font-normal text-muted-foreground text-xs"
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
          <HugeiconsIcon className="size-4" icon={Settings01Icon} />
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
