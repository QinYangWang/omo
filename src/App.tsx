import { useCallback, useEffect, useRef, useState } from "react";
import {
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
      className="group relative w-px shrink-0 cursor-col-resize bg-[#242424] hover:bg-[#3a3a3a]"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

export default function App() {
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

  if (view === "settings") {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-10 shrink-0 pr-36 [-webkit-app-region:drag]">
          <div className="flex w-60 shrink-0 items-center bg-[#161616] pl-5 text-sm font-medium">omo</div>
          <div className="w-px shrink-0 bg-[#242424]" />
          <div className="flex-1 bg-background" />
        </header>
        <div className="min-h-0 flex-1">
          <SettingsView onBack={() => setView("chat")} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Col 1: Sidebar */}
      {collapsed ? (
        <div className="flex w-12 shrink-0 flex-col items-center bg-[#161616] py-2">
          <div className="flex h-8 items-center" style={noDrag}>
            <Button variant="ghost" size="icon" aria-label="Expand sidebar" onClick={() => setCollapsed(false)}>
              <PanelLeft className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 flex-col bg-[#161616]" style={{ width: sidebarW }}>
          <div className="flex h-10 shrink-0 items-center justify-between pl-4 pr-1 [-webkit-app-region:drag]">
            <span className="text-sm font-medium">omo</span>
            <div style={noDrag}>
              <Button variant="ghost" size="icon" aria-label="Collapse sidebar" onClick={() => setCollapsed(true)}>
                <PanelLeftClose className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Sidebar
              projects={projects}
              sessions={sessions}
              activeSession={active?.path ?? active?.key ?? null}
              onAddProject={addProject}
              onNewSession={async (project) => {
                const key = crypto.randomUUID();
                setActive({ key, cwd: project.cwd, project: project.name, title: "New task" });
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
      <Divider onDrag={(dx) => !collapsed && setSidebarW((w) => clamp(w + dx, 180, 400))} />

      {/* Col 2: Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`flex h-10 shrink-0 items-center gap-1 pl-4 [-webkit-app-region:drag] ${panelOpen ? "pr-2" : "pr-36"}`}
        >
          <div className="min-w-0 flex-1 truncate text-sm">
            {active?.title ?? "New task"}
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
            <RightPanel surface={surface} onSelect={setSurface} onClose={() => setPanelOpen(false)} full />
          </div>
        </>
      )}
    </div>
  );
}
