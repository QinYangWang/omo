import {
  Add01Icon,
  AddCircleIcon,
  Folder03Icon,
  ImportIcon,
  PinIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type MouseEvent, useState } from "react";
import {
  SessionActions,
  SessionDetailsHover,
} from "@/components/session-actions";
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
import { Spinner } from "@/components/ui/spinner";
import { type I18nKey, useI18n } from "@/lib/i18n";
import { getServerApi, useServers } from "@/lib/servers";
import {
  sessionKey,
  setSessionPref,
  useSessionPrefs,
} from "@/lib/session-prefs";
import { useStreamingSessions } from "@/lib/session-streaming";
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

function scrollTitleOnHover(event: MouseEvent<HTMLElement>) {
  const title = event.currentTarget.querySelector<HTMLElement>(
    "[data-session-title]"
  );
  if (!title) {
    return;
  }
  const shrink = Number(title.dataset.shrink ?? 0);
  const visible = title.scrollWidth - title.clientWidth;
  // Only compensate for the hover action buttons (shrink) when the title
  // actually overflows, otherwise fitting titles would scroll needlessly.
  const overflow = visible > 0 ? visible + shrink : 0;
  title.style.setProperty("--marquee-dist", `${-Math.max(0, overflow)}px`);
}

function SessionRow({
  project,
  session,
  prefKey,
  pinned,
  isActive,
  isStreaming,
  onChanged,
  onCloned,
  onSelect,
}: {
  project: Project;
  session: PiSession;
  prefKey: string;
  pinned: boolean;
  isActive: boolean;
  isStreaming: boolean;
  onChanged: (name?: string) => Promise<void>;
  onCloned: (path: string) => Promise<void>;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const snapshot = {
    project: project.name,
    title: session.name || session.firstMessage || t("untitled"),
  };
  return (
    <div className="group relative">
      <SessionDetailsHover project={project} session={session}>
        <Button
          className={cn(
            "h-9 w-full justify-start rounded-lg pr-9 pl-8 text-left font-normal text-[13px] text-muted-foreground hover:text-foreground",
            isActive && "bg-accent text-foreground"
          )}
          onClick={onSelect}
          onMouseEnter={scrollTitleOnHover}
          variant="ghost"
        >
          <span className="min-w-0 flex-1 overflow-hidden">
            <span
              className="block truncate group-hover:inline-block group-hover:w-max group-hover:animate-[omo-marquee_4s_ease-in-out_infinite_alternate] group-hover:overflow-visible group-hover:text-clip"
              data-session-title
              data-shrink="0"
            >
              {session.name || session.firstMessage || t("untitled")}
            </span>
          </span>
        </Button>
      </SessionDetailsHover>
      <Button
        aria-label={pinned ? t("unpin_session") : t("pin_session")}
        className={cn(
          "absolute top-1 left-1 size-7 transition-opacity",
          pinned
            ? "opacity-80"
            : "opacity-0 group-focus-within:opacity-70 group-hover:opacity-70"
        )}
        onClick={() =>
          setSessionPref(prefKey, { ...snapshot, pinned: !pinned })
        }
        size="icon"
        title={pinned ? t("unpin_session") : t("pin_session")}
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon
          className={cn(pinned && "fill-current")}
          icon={PinIcon}
        />
      </Button>
      <div className="absolute top-1 right-1 size-7">
        {isStreaming ? (
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground group-focus-within:hidden group-hover:hidden">
            <Spinner className="size-3.5" />
          </span>
        ) : null}
        <SessionActions
          className="absolute inset-0 size-7 opacity-0 transition-opacity group-focus-within:opacity-70 group-hover:opacity-70"
          onArchived={() =>
            setSessionPref(prefKey, { ...snapshot, archived: true })
          }
          onChanged={onChanged}
          onCloned={onCloned}
          project={project}
          session={session}
        />
      </div>
    </div>
  );
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
  onSessionsChanged,
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
  onSessionsChanged: (
    project: Project,
    clonedPath?: string,
    renamedPath?: string,
    name?: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const servers = useServers();
  const prefs = useSessionPrefs();
  const streamingSessions = useStreamingSessions();
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
      <div className="flex flex-col gap-0.5 px-3 pt-2 pb-5">
        <Button
          className="h-9 w-full justify-start gap-2.5 rounded-lg border border-sidebar-border/70 bg-background/40 px-2 font-normal shadow-xs"
          disabled={projects.length === 0}
          onClick={onNewSessionAny}
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={AddCircleIcon} />{" "}
          {t("new_session")}
        </Button>
      </div>
      <div className="group/header flex items-center justify-between px-5 pb-2 text-muted-foreground text-xs">
        <span>{t("projects")}</span>
        <Button
          aria-label={t("add_project")}
          className="size-6 opacity-60 hover:opacity-100 focus-visible:opacity-100"
          onClick={onRequestAddProject}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={Add01Icon} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-3 pb-4">
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
                  <div className="group flex h-9 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-muted dark:hover:bg-muted/50">
                    <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        icon={Folder03Icon}
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
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={AddCircleIcon}
                      />
                    </Button>
                  </div>
                  <CollapsibleContent>
                    <div>
                      {visibleSessions.map((session) => {
                        const key = sessionKey(project.serverId, session.path);
                        const pinned = !!prefs[key]?.pinned;
                        return (
                          <SessionRow
                            isActive={
                              activeSession === session.path ||
                              activeSession === session.id
                            }
                            isStreaming={
                              streamingSessions[
                                `${project.serverId}:${session.id}`
                              ] ?? false
                            }
                            key={session.path}
                            onChanged={(name) =>
                              onSessionsChanged(
                                project,
                                undefined,
                                session.path,
                                name
                              )
                            }
                            onCloned={(path) =>
                              onSessionsChanged(project, path)
                            }
                            onSelect={() => onSelectSession(project, session)}
                            pinned={pinned}
                            prefKey={key}
                            project={project}
                            session={session}
                          />
                        );
                      })}
                      {projectSessionItems.length > COLLAPSED_SESSION_LIMIT ? (
                        <Button
                          className="h-7 w-full justify-start pr-2 pl-8 font-normal text-muted-foreground text-xs"
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
      <div className="p-3">
        <Button
          aria-label={t("settings")}
          className="h-9 w-full justify-start gap-2.5 px-2 font-normal text-muted-foreground"
          onClick={onOpenSettings}
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={Settings01Icon} />
          {t("settings")}
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
                  className="h-auto w-full min-w-0 flex-col items-start gap-0 rounded-md px-3 py-2 text-left font-normal"
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
