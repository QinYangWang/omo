import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  PanelRight,
  PanelLeft,
  PanelLeftClose,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { RightPanel, type Surface } from "@/components/RightPanel";
import { SettingsView } from "@/components/SettingsView";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

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
    <div
      onMouseDown={onMouseDown}
      className="group relative w-px shrink-0 cursor-col-resize bg-border hover:bg-accent"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Record<string, PiSession[]>>({});
  const [active, setActive] = useState<{
    key: string;
    cwd: string;
    project: string;
    title: string;
    path?: string;
  } | null>(null);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sidebarW, setSidebarW] = useState(240);
  const [panelW, setPanelW] = useState(400);
  const [collapsed, setCollapsed] = useState(false);
  const isMac = /Mac/.test(navigator.platform);

  const refreshSessions = async (project: Project) => {
    const list = await window.omo.sessions.list(project.cwd);
    setSessions((current) => ({ ...current, [project.id]: list }));
  };

  useEffect(() => {
    window.omo.projects.list().then((items) => {
      setProjects(items);
      items.forEach(refreshSessions);
    });
  }, []);

  const addProject = async () => {
    const project = await window.omo.projects.add();
    if (!project) return;
    setProjects((items) => (items.some((p) => p.id === project.id) ? items : [...items, project]));
    await refreshSessions(project);
    return project;
  };

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const sessionEntries = projects.flatMap((project) =>
    (sessions[project.id] ?? []).map((session) => ({ project, session }))
  );
  const activeSessionIndex = sessionEntries.findIndex(
    ({ session }) => session.path === active?.path || session.id === active?.key
  );
  const openSessionAt = (index: number) => {
    const entry = sessionEntries[index];
    if (!entry) return;
    setActive({
      key: entry.session.id,
      path: entry.session.path,
      cwd: entry.project.cwd,
      project: entry.project.name,
      title: entry.session.name || entry.session.firstMessage || "Untitled session",
    });
  };
  const headerNavigation = (
    <div className="flex items-center gap-0.5" style={noDrag}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous session"
        disabled={activeSessionIndex <= 0}
        onClick={() => openSessionAt(activeSessionIndex - 1)}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next session"
        disabled={activeSessionIndex < 0 || activeSessionIndex >= sessionEntries.length - 1}
        onClick={() => openSessionAt(activeSessionIndex + 1)}
      >
        <ArrowRight className="size-4" />
      </Button>
    </div>
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
        <header className="flex h-10 shrink-0 [-webkit-app-region:drag]">
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
            {collapsed && headerNavigation}
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <SettingsView onBack={() => setView("chat")} sidebarOpen={!collapsed} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Col 1: Sidebar */}
      {!collapsed && (
        <div className="flex shrink-0 flex-col bg-sidebar" style={{ width: sidebarW }}>
          <div
            className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]"
            style={{ paddingLeft: titlebarLeftPadding }}
          >
            {headerNavigation}
          </div>
          <div className="min-h-0 flex-1">
            <Sidebar
              projects={projects}
              sessions={sessions}
              activeSession={active?.path ?? active?.key ?? null}
              onAddProject={addProject}
              onNewSession={async (project) => {
                const key = crypto.randomUUID();
                setActive({ key, cwd: project.cwd, project: project.name, title: "" });
                await window.omo.pi.open(key, project.cwd);
                await refreshSessions(project);
              }}
              onSelectSession={(project, session) =>
                setActive({
                  key: session.id,
                  path: session.path,
                  cwd: project.cwd,
                  project: project.name,
                  title: session.name || session.firstMessage || "Untitled session",
                })
              }
              onImport={async (project, sourcePath) => {
                await window.omo.sessions.import(sourcePath, project.cwd);
                await refreshSessions(project);
              }}
              onOpenSettings={() => setView("settings")}
            />
          </div>
        </div>
      )}
      {!collapsed && <Divider onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 180, 400))} />}

      {/* Col 2: Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-10 shrink-0 items-center gap-1 [-webkit-app-region:drag]"
          style={{
            paddingLeft: collapsed ? titlebarLeftPadding : "1rem",
            paddingRight: panelOpen ? "0.5rem" : titlebarRightPadding,
          }}
        >
          {collapsed && headerNavigation}
          <div className={cn("min-w-0 flex-1 truncate text-sm", collapsed && "pl-2")}>
            {active?.title ?? t("new_task")}
          </div>
          <div className="flex items-center" style={noDrag}>
            <Button variant="ghost" size="icon" aria-label="Session info">
              <Info className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Toggle panel" onClick={() => setPanelOpen((v) => !v)}>
              <PanelRight className="size-4" />
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1">
          <ChatView
            session={active}
            projects={projects}
            onSelectProject={(project) =>
              setActive({
                key: crypto.randomUUID(),
                cwd: project.cwd,
                project: project.name,
                title: "New task",
              })
            }
            onAddProject={addProject}
            onClearProject={() => setActive(null)}
          />
        </main>
      </div>

      {/* Col 3: Right panel */}
      {panelOpen && (
        <>
          <Divider onDrag={(dx) => setPanelW((w) => clamp(w - dx, 280, 640))} />
          <div className="shrink-0 overflow-hidden" style={{ width: panelW }}>
            <RightPanel surface={surface} onSelect={setSurface} full />
          </div>
        </>
      )}
    </div>
  );
}
