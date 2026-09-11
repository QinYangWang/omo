import {
  PanelRightCloseIcon,
  PanelRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { ChatView } from "@/components/ChatView";
import { Sidebar } from "@/components/Sidebar";
import { TopBar, type TopBarTab } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import { getServerApi, type OmoServer, useServers } from "@/lib/servers";
import { useStreamingSessions } from "@/lib/session-streaming";
import {
  rememberSessionWorkspace,
  type SessionWorkspace,
  sessionWorkspaceId,
} from "@/lib/session-workspaces";
import { useTheme } from "@/lib/theme";
import { normalizeColorToHex } from "@/lib/theme-tokens";
import { cn, randomUUID } from "@/lib/utils";

const loadSettingsView = () =>
  import("@/components/SettingsView").then(({ SettingsView: Component }) => ({
    default: Component,
  }));
const SettingsView = lazy(loadSettingsView);
const preloadSettingsView = (): void => {
  loadSettingsView().catch(() => undefined);
};
const Workspace = lazy(() =>
  import("@/components/Workspace").then(({ Workspace: Component }) => ({
    default: Component,
  }))
);

const macPlatformPattern = /Mac/;

interface ActiveSession {
  cwd: string;
  key: string;
  path?: string;
  project: string;
  projectId: string;
  serverId: string;
  title: string;
}

interface AppTab {
  draftKey: string;
  id: string;
  session: ActiveSession | null;
}

const createAppTab = (session: ActiveSession | null = null): AppTab => ({
  draftKey: randomUUID(),
  id: randomUUID(),
  session,
});

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

function dedupeSessions(items: PiSession[]): PiSession[] {
  const unique = new Map<string, PiSession>();
  for (const session of items) {
    const key = session.id || session.path;
    const current = unique.get(key);
    if (!current || session.modified > current.modified) {
      unique.set(key, session);
    }
  }
  return [...unique.values()];
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
  const unique = new Map<string, Project>();
  for (const project of results.flat()) {
    unique.set(`${project.serverId}:${project.cwd}`, project);
  }
  return [...unique.values()];
}

async function loadSessionMap(
  tagged: Project[]
): Promise<Record<string, PiSession[]>> {
  const nextSessions: Record<string, PiSession[]> = {};
  await Promise.all(
    tagged.map(async (project) => {
      try {
        nextSessions[project.id] = dedupeSessions(
          await getServerApi(project.serverId).sessions.list(project.cwd)
        );
      } catch (error) {
        console.warn(`Unable to list sessions of ${project.name}`, error);
      }
    })
  );
  return nextSessions;
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
  const [tabs, setTabs] = useState<AppTab[]>(() => [createAppTab()]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id ?? "");
  const tabHistory = useRef<string[]>([activeTabId]);
  const tabHistoryIndex = useRef(0);
  const [workspaceContexts, setWorkspaceContexts] = useState<
    SessionWorkspace[]
  >([]);
  const [sidebarW, setSidebarW] = useState(() =>
    loadWidth("omo.layout.sidebarW", 310)
  );
  const [convW, setConvW] = useState(() => loadWidth("omo.layout.convW", 460));
  const [workspaceOpenBySession, setWorkspaceOpenBySession] = useState<
    Record<string, boolean>
  >({});
  const [collapsed, setCollapsed] = useState(false);
  const isMac = macPlatformPattern.test(navigator.platform);
  const { t } = useI18n();
  const streamingSessions = useStreamingSessions();
  useTitleBarOverlay(theme);

  useEffect(() => {
    const preload = () => preloadSettingsView();
    if (window.requestIdleCallback) {
      const idleCallback = window.requestIdleCallback(preload, {
        timeout: 1000,
      });
      return () => window.cancelIdleCallback(idleCallback);
    }
    const timer = window.setTimeout(preload, 250);
    return () => window.clearTimeout(timer);
  }, []);

  const servers = useServers();
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activeSession = activeTab?.session ?? null;
  const activeWorkspaceKey = activeSession
    ? sessionWorkspaceId(activeSession)
    : `tab:${activeTabId}`;
  const panelOpen = workspaceOpenBySession[activeWorkspaceKey] ?? false;

  const toggleWorkspace = useCallback(() => {
    setWorkspaceOpenBySession((current) => ({
      ...current,
      [activeWorkspaceKey]: !(current[activeWorkspaceKey] ?? false),
    }));
  }, [activeWorkspaceKey]);

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
    const unique = dedupeSessions(list);
    setSessions((current) => ({ ...current, [project.id]: unique }));
    return unique;
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

  const selectTab = useCallback(
    (id: string) => {
      if (id === activeTabId) {
        return;
      }
      const history = tabHistory.current.slice(0, tabHistoryIndex.current + 1);
      if (history.at(-1) !== id) {
        history.push(id);
      }
      tabHistory.current = history;
      tabHistoryIndex.current = history.length - 1;
      setActiveTabId(id);
    },
    [activeTabId]
  );

  const createTab = useCallback(
    (session: ActiveSession | null = null) => {
      const tab = createAppTab(session);
      setTabs((current) => [...current, tab]);
      selectTab(tab.id);
      return tab;
    },
    [selectTab]
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) {
        return;
      }
      if (tabs.length === 1) {
        const replacement = createAppTab();
        setTabs([replacement]);
        selectTab(replacement.id);
        return;
      }
      const remaining = tabs.filter((tab) => tab.id !== tabId);
      setTabs(remaining);
      if (tabId === activeTabId) {
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) {
          selectTab(next.id);
        }
      }
    },
    [activeTabId, selectTab, tabs]
  );

  useEffect(() => {
    const validIds = new Set(tabs.map((tab) => tab.id));
    const history = tabHistory.current.filter((id) => validIds.has(id));
    if (history.length === 0 && tabs[0]) {
      history.push(tabs[0].id);
    }
    tabHistory.current = history;
    tabHistoryIndex.current = Math.max(
      0,
      Math.min(
        tabHistoryIndex.current,
        Math.max(0, tabHistory.current.length - 1)
      )
    );
  }, [tabs]);

  const navigateTabs = useCallback(
    (direction: -1 | 1) => {
      const validIds = new Set(tabs.map((tab) => tab.id));
      const history = tabHistory.current.filter((id) => validIds.has(id));
      const currentIndex = history.indexOf(activeTabId);
      const nextIndex = currentIndex + direction;
      const nextId = history[nextIndex];
      if (nextId === undefined) {
        return;
      }
      tabHistory.current = history;
      tabHistoryIndex.current = nextIndex;
      setActiveTabId(nextId);
    },
    [activeTabId, tabs]
  );

  const updateTabSession = useCallback(
    (
      tabId: string,
      update: (session: ActiveSession | null) => ActiveSession | null
    ) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId ? { ...tab, session: update(tab.session) } : tab
        )
      );
    },
    []
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
    createTab({
      cwd: project.cwd,
      key,
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "",
    });
    setView("chat");
    await getServerApi(project.serverId).pi.open(key, project.cwd);
  };

  const openAddedProject = (project: Project) => {
    createTab({
      cwd: project.cwd,
      key: randomUUID(),
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "",
    });
    setView("chat");
  };

  const openSession = useCallback(
    (project: Project, session: PiSession) => {
      const existing = tabs.find(
        (tab) =>
          tab.session?.serverId === project.serverId &&
          tab.session.projectId === project.id &&
          (tab.session.path === session.path || tab.session.key === session.id)
      );
      if (existing) {
        selectTab(existing.id);
      } else {
        createTab({
          cwd: project.cwd,
          key: session.id,
          path: session.path,
          project: project.name,
          projectId: project.id,
          serverId: project.serverId,
          title: session.name || session.firstMessage || t("untitled"),
        });
      }
      setView("chat");
    },
    [createTab, selectTab, t, tabs]
  );

  const selectProjectInTab = (project: Project, tabId: string) => {
    updateTabSession(tabId, () => ({
      cwd: project.cwd,
      key: randomUUID(),
      project: project.name,
      projectId: project.id,
      serverId: project.serverId,
      title: "",
    }));
  };

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  useEffect(() => {
    setWorkspaceContexts((current) =>
      rememberSessionWorkspace(current, activeSession)
    );
  }, [activeSession]);

  useEffect(() => {
    localStorage.setItem("omo.layout.sidebarW", String(sidebarW));
  }, [sidebarW]);
  useEffect(() => {
    localStorage.setItem("omo.layout.convW", String(convW));
  }, [convW]);

  const sessionChanged = async (
    project: Project,
    sessionPath: string,
    name?: string
  ) => {
    await refreshSessions(project);
    if (!name) {
      return;
    }
    setTabs((current) =>
      current.map((tab) =>
        tab.session?.projectId === project.id &&
        tab.session.path === sessionPath
          ? { ...tab, session: { ...tab.session, title: name } }
          : tab
      )
    );
  };

  const sessionCloned = async (project: Project, path: string) => {
    const list = await refreshSessions(project);
    const cloned = list.find((item) => item.path === path);
    if (cloned) {
      openSession(project, cloned);
    }
  };

  const topbarTabs: TopBarTab[] = tabs.map(({ id, session }) => {
    const label = session?.title.trim() || t("new_thread");
    return {
      id,
      label,
      streaming: session
        ? !!streamingSessions[`${session.serverId}:${session.key}`]
        : false,
      title: session ? `${session.project} · ${label}` : label,
    };
  });

  // Keep the tab strip aligned with the sidebar edge. On macOS the traffic
  // lights occupy part of the left padding, so subtract it from the segment.
  const titlebarLeftPadding = isMac
    ? "max(0.75rem, calc(env(titlebar-area-x, 68px) + 0.5rem))"
    : "0.5rem";
  const titlebarRightPadding = isMac
    ? "0.5rem"
    : "max(0.5rem, calc(100vw - env(titlebar-area-x, 100vw) - env(titlebar-area-width, 0px) + 0.5rem))";
  const topbarLeftWidth = (() => {
    if (collapsed) {
      return 48;
    }
    if (view === "settings") {
      return sidebarW;
    }
    // Align the first session tab with the conversation pane after the
    // invisible resize area and its p-2 inset.
    return sidebarW + 5;
  })();
  const validHistory = tabHistory.current.filter((id) =>
    tabs.some((tab) => tab.id === id)
  );
  const historyPosition = validHistory.indexOf(activeTabId);
  const canGoBack = historyPosition > 0;
  const canGoForward =
    historyPosition >= 0 && historyPosition < validHistory.length - 1;

  const topBar = (
    <TopBar
      activeTabId={activeTabId}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      collapsed={collapsed}
      leftPadding={titlebarLeftPadding}
      leftWidth={topbarLeftWidth}
      onCloseTab={closeTab}
      onCollapse={() => setCollapsed((value) => !value)}
      onGoBack={() => navigateTabs(-1)}
      onGoForward={() => navigateTabs(1)}
      onNewTab={() => {
        setView("chat");
        createTab();
      }}
      onSelectTab={(id) => {
        setView("chat");
        selectTab(id);
      }}
      rightPadding={titlebarRightPadding}
      tabs={topbarTabs}
    />
  );

  if (!activeTab) {
    return null;
  }

  if (view === "settings") {
    return (
      <div className="relative h-screen overflow-hidden bg-sidebar text-foreground">
        {topBar}
        <main className="absolute inset-0 z-30 overflow-hidden">
          <Suspense fallback={null}>
            <SettingsView
              onBack={() => setView("chat")}
              onCollapse={() => setCollapsed((value) => !value)}
              sidebarOpen={!collapsed}
              sidebarWidth={sidebarW}
              titlebarLeftPadding={titlebarLeftPadding}
            />
          </Suspense>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-sidebar text-foreground">
      {topBar}
      <div className="flex min-h-0 flex-1">
        {/* Col 1: Sidebar */}
        {!collapsed && (
          <div
            className="flex shrink-0 flex-col bg-sidebar"
            style={{ width: sidebarW }}
          >
            <div className="min-h-0 flex-1">
              <Sidebar
                activeSession={
                  activeSession?.path ?? activeSession?.key ?? null
                }
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
                    projects.find(
                      (item) => item.id === activeSession?.projectId
                    ) ?? projects[0];
                  if (project) {
                    await startNewSession(project);
                  }
                }}
                onOpenSettings={() => setView("settings")}
                onPrefetchSettings={preloadSettingsView}
                onRequestAddProject={() => setAddOpen(true)}
                onSelectSession={openSession}
                onSessionsChanged={async (
                  project,
                  clonedPath,
                  renamedPath,
                  name
                ) => {
                  if (clonedPath) {
                    await sessionCloned(project, clonedPath);
                  } else if (renamedPath) {
                    await sessionChanged(project, renamedPath, name);
                  } else {
                    await refreshSessions(project);
                  }
                }}
                projects={projects}
                sessions={sessions}
              />
            </div>
          </div>
        )}
        {!collapsed && (
          <Divider
            className="top-0 bg-transparent hover:bg-transparent group-hover:bg-transparent"
            onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 240, 400))}
          />
        )}

        <div className="flex min-w-0 flex-1 gap-2 p-2">
          <main
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-background shadow-sm/5",
              panelOpen ? "shrink-0" : "flex-1"
            )}
            style={{ width: panelOpen ? convW : undefined }}
          >
            <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
              <h2 className="min-w-0 truncate font-medium text-sm">
                {activeSession?.title.trim() || t("new_thread")}
              </h2>
              <span className="min-w-0 flex-1" />
              <Button
                aria-label={t("toggle_workspace")}
                aria-pressed={panelOpen}
                className="size-7"
                onClick={toggleWorkspace}
                size="icon"
                title={t("toggle_workspace")}
                variant="ghost"
              >
                <HugeiconsIcon
                  icon={panelOpen ? PanelRightCloseIcon : PanelRightIcon}
                />
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-background">
              <ChatView
                draftKey={activeTab.draftKey}
                key={`${activeTab.id}:${activeSession?.serverId ?? "local"}:${activeSession?.key ?? activeTab.draftKey}`}
                onClearProject={() =>
                  updateTabSession(activeTab.id, () => null)
                }
                onRequestAddProject={() => setAddOpen(true)}
                onSelectProject={(project) =>
                  selectProjectInTab(project, activeTab.id)
                }
                onSessionBound={({ key, path, projectId, title }) => {
                  // Guard against the user having switched tabs while the
                  // prompt was in flight.
                  setTabs((current) =>
                    current.map((tab) =>
                      tab.id === activeTab.id &&
                      tab.session?.key === key &&
                      !tab.session.path
                        ? {
                            ...tab,
                            session: {
                              ...tab.session,
                              path,
                              title: tab.session.title || title,
                            },
                          }
                        : tab
                    )
                  );
                  const project = projects.find(
                    (item) => item.id === projectId
                  );
                  if (project) {
                    pollForSession(project, path, 0).catch(() => undefined);
                  }
                }}
                projects={projects}
                session={activeSession}
              />
            </div>
          </main>
          <Divider
            className={cn(
              "top-0 bg-transparent hover:bg-transparent group-hover:bg-transparent",
              !panelOpen && "hidden"
            )}
            onDrag={(dx) => setConvW((w) => clamp(w + dx, 380, 560))}
          />
          <aside
            className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-background shadow-sm/5"
            hidden={!panelOpen}
          >
            <Suspense fallback={null}>
              {workspaceContexts.map((workspace) => (
                <div
                  className="h-full"
                  hidden={workspace.id !== sessionWorkspaceId(activeSession)}
                  key={workspace.id}
                >
                  <Workspace
                    cwd={workspace.cwd}
                    serverId={workspace.serverId}
                    sessionId={workspace.sessionId}
                    sessionPath={workspace.sessionPath}
                    terminalKey={workspace.id}
                  />
                </div>
              ))}
            </Suspense>
          </aside>
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
