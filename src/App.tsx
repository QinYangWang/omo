import {
  Folder01Icon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { ChatView } from "@/components/ChatView";
import { SettingsView } from "@/components/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Workspace } from "@/components/Workspace";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import {
  getDefaultServerId,
  getServerApi,
  type OmoServer,
  useServers,
} from "@/lib/servers";
import { useTheme } from "@/lib/theme";
import { normalizeColorToHex } from "@/lib/theme-tokens";
import { cn, randomUUID } from "@/lib/utils";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const macPlatformPattern = /Mac/;

function syncWindowTitle() {
  const styles = getComputedStyle(document.documentElement);
  const color = normalizeColorToHex(styles.getPropertyValue("--sidebar"));
  const symbolColor = normalizeColorToHex(
    styles.getPropertyValue("--window-control")
  );
  if (!(color && symbolColor)) {
    return;
  }
  omo.windowControls.setTitleBarOverlay({ color, symbolColor });
}

/** Keep the native title bar overlay color in sync with the applied theme. */
function useTitleBarOverlay(theme: "dark" | "light" | "system") {
  useEffect(() => {
    let frame = requestAnimationFrame(syncWindowTitle);
    const resync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncWindowTitle);
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    if (theme === "system") {
      media.addEventListener("change", resync);
    }
    const observer = new MutationObserver(resync);
    observer.observe(document.head, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", resync);
      observer.disconnect();
    };
  }, [theme]);
}

async function loadTaggedProjects(servers: OmoServer[]): Promise<Project[]> {
  const results = await Promise.all(
    servers.map(async (server) => {
      try {
        const items = await getServerApi(server.id).projects.list();
        return items.map((project) => ({
          ...project,
          id: `${server.id}:${project.id}`,
          serverId: server.id,
        }));
      } catch (error) {
        console.warn(`Unable to list projects of ${server.name}`, error);
        return [];
      }
    })
  );
  return results.flat();
}

async function loadSessionMap(
  tagged: Project[]
): Promise<Record<string, PiSession[]>> {
  const nextSessions: Record<string, PiSession[]> = {};
  await Promise.all(
    tagged.map(async (project) => {
      try {
        nextSessions[project.id] = await getServerApi(
          project.serverId
        ).sessions.list(project.cwd);
      } catch (error) {
        console.warn(`Unable to list sessions of ${project.name}`, error);
      }
    })
  );
  return nextSessions;
}

function HeaderNav({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5" style={noDrag}>
      <Button
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onCollapse}
        size="icon"
        variant="ghost"
      >
        {collapsed ? (
          <HugeiconsIcon className="size-4" icon={PanelLeftIcon} />
        ) : (
          <HugeiconsIcon className="size-4" icon={PanelLeftCloseIcon} />
        )}
      </Button>
    </div>
  );
}

function loadWidth(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return value > 0 ? value : fallback;
}

function Divider({
  className,
  onDrag,
}: {
  className?: string;
  onDrag: (dx: number) => void;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      let last = 0;
      const move = (ev: PointerEvent) => {
        onDrag(ev.clientX - startX - last);
        last = ev.clientX - startX;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onDrag]
  );
  return (
    <Button
      aria-label="Resize panel"
      className={cn(
        "group relative m-0 h-full w-px shrink-0 cursor-col-resize rounded-none border-0 bg-transparent p-0 active:translate-y-0"
      )}
      onPointerDown={onPointerDown}
      type="button"
      variant="ghost"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -right-1 -left-1"
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute bottom-0 left-0 w-px",
          className ?? "top-0 bg-border/60 group-hover:bg-ring"
        )}
      />
    </Button>
  );
}

export default function App() {
  const { theme } = useTheme();
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Record<string, PiSession[]>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [active, setActive] = useState<{
    key: string;
    cwd: string;
    project: string;
    projectId: string;
    serverId: string;
    title: string;
    path?: string;
  } | null>(null);
  const [sidebarW, setSidebarW] = useState(() =>
    loadWidth("omo.layout.sidebarW", 310)
  );
  const [convW, setConvW] = useState(() => loadWidth("omo.layout.convW", 460));
  const [panelOpen, setPanelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const isMac = macPlatformPattern.test(navigator.platform);
  const { t } = useI18n();
  useTitleBarOverlay(theme);

  const servers = useServers();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const tagged = await loadTaggedProjects(servers);
      if (cancelled) {
        return;
      }
      setProjects(tagged);
      const sessionsByProject = await loadSessionMap(tagged);
      if (!cancelled) {
        setSessions(sessionsByProject);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [servers]);

  const refreshSessions = useCallback(async (project: Project) => {
    const list = await getServerApi(project.serverId).sessions.list(
      project.cwd
    );
    setSessions((current) => ({ ...current, [project.id]: list }));
    return list;
  }, []);

  // pi writes the session JSONL asynchronously (often only once the first
  // assistant message lands), so poll until the new row shows up.
  const pollForSession = useCallback(
    async (project: Project, path: string, attempt: number): Promise<void> => {
      if (attempt >= 15) {
        return;
      }
      const list = await refreshSessions(project);
      if (list.some((session) => session.path === path)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await pollForSession(project, path, attempt + 1);
    },
    [refreshSessions]
  );

  const addProject = async (serverId: string, path?: string) => {
    const project = await getServerApi(serverId).projects.add(path);
    if (!project) {
      return;
    }
    const tagged = {
      ...project,
      id: `${serverId}:${project.id}`,
      serverId,
    };
    setProjects((items) =>
      items.some((p) => p.id === tagged.id) ? items : [...items, tagged]
    );
    return tagged;
  };

  const startNewSession = async (project: Project) => {
    const key = randomUUID();
    setActive({
      cwd: project.cwd,
      key,
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "",
    });
    await getServerApi(project.serverId).pi.open(key, project.cwd);
  };

  const openAddedProject = (project: Project) => {
    setActive({
      cwd: project.cwd,
      key: randomUUID(),
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "",
    });
  };

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  useEffect(() => {
    localStorage.setItem("omo.layout.sidebarW", String(sidebarW));
  }, [sidebarW]);
  useEffect(() => {
    localStorage.setItem("omo.layout.convW", String(convW));
  }, [convW]);

  const headerNavigation = (
    <HeaderNav
      collapsed={collapsed}
      onCollapse={() => setCollapsed((value) => !value)}
    />
  );

  const titlebarLeftPadding = isMac
    ? "max(0.5rem, calc(env(titlebar-area-x, 68px) + 0.5rem))"
    : "0.5rem";
  const titlebarRightPadding = isMac
    ? "0.5rem"
    : "max(0.5rem, calc(100vw - env(titlebar-area-x, 100vw) - env(titlebar-area-width, 0px) + 0.5rem))";

  if (view === "settings") {
    return (
      <div className="flex h-screen flex-col bg-sidebar text-foreground">
        <header
          className="flex h-10 shrink-0 items-center gap-2 bg-sidebar [-webkit-app-region:drag]"
          style={{
            paddingLeft: titlebarLeftPadding,
            paddingRight: titlebarRightPadding,
          }}
        >
          {headerNavigation}
        </header>
        <div className="min-h-0 flex-1">
          <SettingsView
            onBack={() => setView("chat")}
            sidebarOpen={!collapsed}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-sidebar text-foreground">
      {/* Top strip: unified surface with the sidebar, shows no text */}
      <header
        className="flex h-10 shrink-0 items-center gap-2 bg-sidebar [-webkit-app-region:drag]"
        style={{
          paddingLeft: titlebarLeftPadding,
          paddingRight: titlebarRightPadding,
        }}
      >
        {headerNavigation}
      </header>
      <div className="flex min-h-0 flex-1">
        {/* Col 1: Sidebar */}
        {!collapsed && (
          <div
            className="flex shrink-0 flex-col bg-sidebar"
            style={{ width: sidebarW }}
          >
            <div className="min-h-0 flex-1">
              <Sidebar
                activeSession={active?.path ?? active?.key ?? null}
                onImport={async (project, sourcePath) => {
                  await getServerApi(project.serverId).sessions.import(
                    sourcePath,
                    project.cwd
                  );
                  await refreshSessions(project);
                }}
                onNewSession={startNewSession}
                onNewSessionAny={async () => {
                  const project =
                    projects.find((item) => item.id === active?.projectId) ??
                    projects[0];
                  if (project) {
                    await startNewSession(project);
                  }
                }}
                onOpenSettings={() => setView("settings")}
                onRequestAddProject={() => setAddOpen(true)}
                onSelectSession={(project, session) =>
                  setActive({
                    cwd: project.cwd,
                    key: session.id,
                    path: session.path,
                    project: project.name,
                    projectId: project.id,
                    serverId: project.serverId,
                    title:
                      session.name ||
                      session.firstMessage ||
                      "Untitled session",
                  })
                }
                projects={projects}
                sessions={sessions}
              />
            </div>
          </div>
        )}
        {!collapsed && (
          <Divider
            className="top-0 bg-transparent group-hover:bg-ring/40"
            onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 240, 400))}
          />
        )}

        {/* Content pane: top/left borders curve at the sidebar junction */}
        <div
          className={cn(
            "flex min-w-0 flex-1 overflow-hidden border-border border-t bg-background",
            !collapsed && "rounded-tl-lg border-l"
          )}
        >
          {/* Col 2: Conversation */}
          <main
            className={cn(
              "flex min-w-0 flex-col",
              panelOpen ? "shrink-0" : "flex-1"
            )}
            style={{ width: panelOpen ? convW : undefined }}
          >
            {/* Conversation header: session title only */}
            <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b bg-background pr-1.5 pl-3">
              <HugeiconsIcon
                className="size-4 shrink-0 text-muted-foreground"
                icon={Folder01Icon}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-sm">
                {active ? active.title || t("new_session") : null}
              </span>
              <Button
                aria-label="Toggle workspace"
                aria-pressed={panelOpen}
                className="size-7"
                onClick={() => setPanelOpen((v) => !v)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={panelOpen ? PanelRightCloseIcon : PanelRightIcon}
                />
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-background">
              <ChatView
                key={`${active?.serverId ?? "local"}:${active?.key ?? "draft"}`}
                onClearProject={() => setActive(null)}
                onRequestAddProject={() => setAddOpen(true)}
                onSelectProject={(project) =>
                  setActive({
                    cwd: project.cwd,
                    key: randomUUID(),
                    project: project.name,
                    projectId: project.id,
                    serverId: project.serverId,
                    title: "",
                  })
                }
                onSessionBound={({ key, path, projectId, title }) => {
                  // Guard against the user having switched sessions while the
                  // prompt was in flight.
                  setActive((current) =>
                    current && current.key === key && !current.path
                      ? { ...current, path, title: current.title || title }
                      : current
                  );
                  const project = projects.find(
                    (item) => item.id === projectId
                  );
                  if (project) {
                    pollForSession(project, path, 0).catch(() => undefined);
                  }
                }}
                projects={projects}
                session={active}
              />
            </div>
          </main>
          {panelOpen ? (
            <>
              <Divider
                onDrag={(dx) => setConvW((w) => clamp(w + dx, 380, 560))}
              />

              {/* Col 3: Workspace */}
              <div className="min-w-0 flex-1">
                <Workspace
                  serverId={active?.serverId ?? getDefaultServerId()}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
      <AddProjectDialog
        onAdd={addProject}
        onAdded={openAddedProject}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
    </div>
  );
}
