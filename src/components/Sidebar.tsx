import { useState } from "react";
import { Folder, Import, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
  onAddProject: () => void;
  onNewSession: (project: Project) => void;
  onSelectSession: (project: Project, session: PiSession) => void;
  onImport: (project: Project, path: string) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [importProject, setImportProject] = useState<Project | null>(null);
  const [allSessions, setAllSessions] = useState<PiSession[]>([]);

  const openImport = async (project: Project) => {
    setImportProject(project);
    setAllSessions(await window.omo.sessions.all());
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-2 pb-1">
        <Button variant="ghost" className="w-full justify-start gap-2 font-normal">
          <Search className="size-4" /> Search
        </Button>
      </div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
        <span>PROJECTS</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Add project" onClick={onAddProject}>
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 px-2 pb-4">
          {projects.length === 0 && (
            <button className="w-full rounded-md px-2 py-3 text-left text-sm text-muted-foreground hover:bg-accent" onClick={onAddProject}>
              <Folder className="mb-2 size-4" /> Add a local directory
            </button>
          )}
          {projects.map((project) => (
            <section key={project.id}>
              <div className="group flex h-8 items-center gap-2 px-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
                <Button variant="ghost" size="icon" className="size-6 opacity-60 hover:opacity-100" title="Import session" onClick={() => openImport(project)}>
                  <Import className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 opacity-60 hover:opacity-100" title="New session" onClick={() => onNewSession(project)}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <div className="ml-5 border-l border-white/[0.05] pl-1">
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
                    {session.name || session.firstMessage || "Untitled session"}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
      <div className="p-2">
        <Button variant="ghost" size="icon" aria-label="Settings" onClick={onOpenSettings}>
          <Settings className="size-4" />
        </Button>
      </div>

      <Dialog open={!!importProject} onOpenChange={(open) => !open && setImportProject(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Import session to {importProject?.name}</DialogTitle>
            <DialogDescription>Select an existing Pi session. A project-local fork will be created.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-96">
            <div className="space-y-1 pr-2">
              {allSessions.map((session) => (
                <button
                  key={session.path}
                  className="w-full rounded-md px-3 py-2 text-left hover:bg-accent"
                  onClick={async () => {
                    if (!importProject) return;
                    await onImport(importProject, session.path);
                    setImportProject(null);
                  }}
                >
                  <div className="truncate text-sm">{session.name || session.firstMessage || "Untitled session"}</div>
                  <div className="truncate text-xs text-muted-foreground">{session.cwd} · {session.messageCount} messages</div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
