import { ChevronRight, Folder, Monitor } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ServerStatusBadge } from "@/components/SettingsView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type I18nKey, useI18n } from "@/lib/i18n";
import {
  getDefaultServerId,
  getServerApi,
  useServers,
  useServerStatuses,
} from "@/lib/servers";
import { cn } from "@/lib/utils";

interface DirectoryNode {
  name: string;
  path: string;
}

function DirectoryPicker({
  api,
  onSelect,
  onCancel,
}: {
  api: omoApi;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [root, setRoot] = useState("");
  const [nodes, setNodes] = useState<DirectoryNode[]>([]);
  const [stack, setStack] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentPath = stack.at(-1) || root;

  const load = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError("");
      try {
        const target = path || root;
        const entries = await api.fs.list(target);
        setNodes(
          entries
            .filter((item) => item.dir)
            .map((entry) => ({ ...entry, path: `${target}/${entry.name}` }))
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [api, root]
  );

  useEffect(() => {
    api
      .cwd()
      .then(async (path) => {
        setRoot(path);
        const entries = await api.fs.list(path);
        setNodes(
          entries
            .filter((item) => item.dir)
            .map((entry) => ({ ...entry, path: `${path}/${entry.name}` }))
        );
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, [api]);

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
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <ScrollArea className="h-72 rounded-md border border-border">
        <div className="p-1">
          {loading ? (
            <p className="p-2 text-muted-foreground text-sm">Loading…</p>
          ) : null}
          {loading
            ? null
            : nodes.map((node) => (
                <Button
                  className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 font-normal text-sm"
                  key={node.path}
                  onClick={async () => {
                    setStack((items) => [...items, node.path]);
                    await load(node.path);
                  }}
                  variant="ghost"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {node.name}
                  </span>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </Button>
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

export function AddProjectDialog({
  onAdd,
  onAdded,
  onOpenChange,
  open,
}: {
  onAdd: (serverId: string, path?: string) => Promise<Project | null | undefined>;
  onAdded: (project: Project) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const servers = useServers();
  const statuses = useServerStatuses();
  const [serverId, setServerId] = useState(getDefaultServerId());
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;
  const selected =
    servers.find((server) => server.id === serverId) ?? servers[0];
  const nativePicker =
    selected?.kind === "local" && !selected.url && !!window.omoSecure;

  useEffect(() => {
    if (open && !servers.some((server) => server.id === serverId)) {
      setServerId(getDefaultServerId());
    }
  }, [open, servers, serverId]);

  const addFromPath = useCallback(
    async (path: string) => {
      if (!selected) {
        return;
      }
      const project = await onAdd(selected.id, path);
      if (project) {
        onAdded(project);
      }
      onOpenChange(false);
    },
    [onAdd, onAdded, onOpenChange, selected]
  );

  const pickNativeDirectory = async () => {
    if (!selected) {
      return;
    }
    const path = await getServerApi(selected.id).projects.pickDirectory();
    if (path) {
      await addFromPath(path);
    }
  };

  const picker = useMemo(() => {
    if (!(open && selected) || nativePicker) {
      return null;
    }
    return (
      <DirectoryPicker
        api={getServerApi(selected.id)}
        key={selected.id}
        onCancel={() => onOpenChange(false)}
        onSelect={addFromPath}
      />
    );
  }, [open, selected, nativePicker, addFromPath, onOpenChange]);

  const serverLabel = (id: string) => {
    const server = servers.find((item) => item.id === id);
    if (!server) {
      return id;
    }
    if (server.kind === "remote") {
      return server.name;
    }
    return t((hosted ? "server_hosted" : "server_local") as I18nKey);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("add_project")}</DialogTitle>
          <DialogDescription>{t("add_project_desc")}</DialogDescription>
        </DialogHeader>
        {servers.length ? (
          <div className="flex flex-wrap gap-1">
            {servers.map((server) => (
              <Button
                className={cn("gap-2")}
                key={server.id}
                onClick={() => setServerId(server.id)}
                size="sm"
                variant={selected?.id === server.id ? "secondary" : "ghost"}
              >
                <Monitor className="size-3.5" />
                {serverLabel(server.id)}
                <ServerStatusBadge status={statuses[server.id]} />
              </Button>
            ))}
          </div>
        ) : null}
        {nativePicker ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-border p-4">
            <p className="text-muted-foreground text-sm">
              使用操作系统目录选择器选择本地项目目录。
            </p>
            <div className="flex gap-2">
              <Button onClick={pickNativeDirectory}>Choose directory</Button>
              <Button onClick={() => onOpenChange(false)} variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          picker
        )}
      </DialogContent>
    </Dialog>
  );
}
