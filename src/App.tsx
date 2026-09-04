import {
  ArrowLeft,
  ArrowRight,
  Info,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { ChatView } from "@/components/ChatView";
import { RightPanel, type Surface } from "@/components/RightPanel";
import { SettingsView } from "@/components/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import {
  getDefaultServerId,
  getServerApi,
  type OmoServer,
  useServers,
} from "@/lib/servers";
import { useTheme } from "@/lib/theme";
import { cn, randomUUID } from "@/lib/utils";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const macPlatformPattern = /Mac/;

function syncWindowTitle(view: "chat" | "settings", panelOpen: boolean) {
  const styles = getComputedStyle(document.documentElement);
  const colorVariable =
    view === "chat" && panelOpen ? "--window-panel" : "--window-background";
  omo.windowControls.setTitleBarOverlay({
    color: styles.getPropertyValue(colorVariable).trim(),
    symbolColor: styles.getPropertyValue("--window-control").trim(),
  });
}

/** Keep the native title bar overlay color in sync with the applied theme. */
function useTitleBarOverlay(
  view: "chat" | "settings",
  panelOpen: boolean,
  theme: "dark" | "light" | "system"
) {
  useEffect(() => {
    let frame = requestAnimationFrame(() => syncWindowTitle(view, panelOpen));
    const resync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncWindowTitle(view, panelOpen));
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncWindowTitle(view, panelOpen));
    };
    if (theme === "system") {
      media.addEventListener("change", onSchemeChange);
    }
    const observer = new MutationObserver(resync);
    observer.observe(document.head, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", onSchemeChange);
      observer.disconnect();
    };
  }, [panelOpen, theme, view]);
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
  activeSessionIndex,
  canGoNext,
  collapsed,
  onCollapse,
  onNext,
  onPrevious,
}: {
  activeSessionIndex: number;
  canGoNext: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onNext: () => void;
  onPrevious: () => void;
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
          <PanelLeft className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </Button>
      <Button
        aria-label="Previous session"
        disabled={activeSessionIndex <= 0}
        onClick={onPrevious}
        size="icon"
        variant="ghost"
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        aria-label="Next session"
        disabled={activeSessionIndex < 0 || !canGoNext}
        onClick={onNext}
        size="icon"
        variant="ghost"
      >
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
  const startX = useRef(0);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      let last = 0;
      const move = (ev: MouseEvent) => {
        onDrag(ev.clientX - startX.current - last);
        last = ev.clientX - startX.current;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [onDrag]
  );
  return (
    <button
      aria-label="Resize panel"
      className="group relative m-0 w-px shrink-0 cursor-col-resize border-0 bg-border p-0 hover:bg-accent"
      onMouseDown={onMouseDown}
      type="button"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -right-1 -left-1"
      />
    </button>
  );
}

export default function App() {
  const { t } = useI18n();
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
  const [surface, setSurface] = useState<Surface | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sidebarW, setSidebarW] = useState(240);
  const [panelW, setPanelW] = useState(400);
  const [collapsed, setCollapsed] = useState(false);
  const isMac = macPlatformPattern.test(navigator.platform);
  useTitleBarOverlay(view, panelOpen, theme);

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
  }, []);

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

  const openAddedProject = (project: Project) => {
    setActive({
      cwd: project.cwd,
      key: randomUUID(),
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "New task",
    });
  };

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const sessionEntries = projects.flatMap((project) =>
    (sessions[project.id] ?? []).map((session) => ({ project, session }))
  );
  const activeSessionIndex = sessionEntries.findIndex(
    ({ session }) => session.path === active?.path || session.id === active?.key
  );
  const openSessionAt = (index: number) => {
    const entry = sessionEntries[index];
    if (!entry) {
      return;
    }
    setActive({
      cwd: entry.project.cwd,
      key: entry.session.id,
      path: entry.session.path,
      project: entry.project.name,
      projectId: entry.project.id,
      serverId: entry.project.serverId,
      title:
        entry.session.name || entry.session.firstMessage || "Untitled session",
    });
  };
  const headerNavigation = (
    <HeaderNav
      activeSessionIndex={activeSessionIndex}
      canGoNext={activeSessionIndex < sessionEntries.length - 1}
      collapsed={collapsed}
      onCollapse={() => setCollapsed((value) => !value)}
      onNext={() => openSessionAt(activeSessionIndex + 1)}
      onPrevious={() => openSessionAt(activeSessionIndex - 1)}
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
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-10 shrink-0 bg-background [-webkit-app-region:drag]">
          {!collapsed && (
            <>
              <div
                className="flex w-60 shrink-0 items-center bg-sidebar"
                style={{ paddingLeft: titlebarLeftPadding }}
              >
                {headerNavigation}
              </div>
              <div className="w-px shrink-0 bg-border" />
            </>
          )}
          <div
            className="flex min-w-0 flex-1 items-center bg-background"
            style={{
              paddingLeft: collapsed ? titlebarLeftPadding : undefined,
              paddingRight: titlebarRightPadding,
            }}
          >
            {collapsed ? headerNavigation : null}
          </div>
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
    <div className="flex h-screen bg-background text-foreground">
      {/* Col 1: Sidebar */}
      {!collapsed && (
        <div
          className="flex shrink-0 flex-col bg-sidebar"
          style={{ width: sidebarW }}
        >
          <div
            className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]"
            style={{ paddingLeft: titlebarLeftPadding }}
          >
            {headerNavigation}
          </div>
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
              onNewSession={async (project) => {
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
                    session.name || session.firstMessage || "Untitled session",
                })
              }
              projects={projects}
              sessions={sessions}
            />
          </div>
        </div>
      )}
      {!collapsed && (
        <Divider onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 180, 400))} />
      )}

      {/* Col 2: Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-10 shrink-0 items-center gap-1 bg-background [-webkit-app-region:drag]"
          style={{
            paddingLeft: collapsed ? titlebarLeftPadding : "1rem",
            paddingRight: panelOpen ? "0.5rem" : titlebarRightPadding,
          }}
        >
          {collapsed ? headerNavigation : null}
          <div
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              collapsed && "pl-2"
            )}
          >
            {active?.title || t("new_task")}
          </div>
          <div className="flex items-center" style={noDrag}>
            <Button aria-label="Session info" size="icon" variant="ghost">
              <Info className="size-4" />
            </Button>
            <Button
              aria-label="Toggle panel"
              onClick={() => setPanelOpen((v) => !v)}
              size="icon"
              variant="ghost"
            >
              <PanelRight className="size-4" />
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1">
          <ChatView
            onClearProject={() => setActive(null)}
            onRequestAddProject={() => setAddOpen(true)}
            onSelectProject={(project) =>
              setActive({
                cwd: project.cwd,
                key: randomUUID(),
                project: project.name,
                projectId: project.id,
                serverId: project.serverId,
                title: "New task",
              })
            }
            projects={projects}
            session={active}
          />
        </main>
      </div>

      {/* Col 3: Right panel */}
      {panelOpen ? (
        <>
          <Divider onDrag={(dx) => setPanelW((w) => clamp(w - dx, 280, 640))} />
          <div className="shrink-0 overflow-hidden" style={{ width: panelW }}>
            <RightPanel
              full
              onSelect={setSurface}
              serverId={active?.serverId ?? getDefaultServerId()}
              surface={surface}
            />
          </div>
        </>
      ) : null}
      <AddProjectDialog
        onAdd={addProject}
        onAdded={openAddedProject}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
    </div>
  );
}
