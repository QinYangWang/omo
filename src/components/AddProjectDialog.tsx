import {
  ArrowRight01Icon,
  Folder01Icon,
  PiIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { ServerStatusBadge } from "@/components/server-status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type I18nKey, useI18n } from "@/lib/i18n";
import {
  getDefaultServerId,
  getServerApi,
  useServerStatuses,
  useServers,
} from "@/lib/servers";

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
  const { t } = useI18n();
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
          {t("back")}
        </Button>
        <div className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
          {currentPath || "…"}
        </div>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <ScrollArea className="h-72 rounded-md border border-border">
        <div className="p-1">
          {loading ? (
            <p className="p-2 text-muted-foreground text-sm">{t("loading")}</p>
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
                  <HugeiconsIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    icon={Folder01Icon}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {node.name}
                  </span>
                  <HugeiconsIcon
                    className="size-3.5 text-muted-foreground"
                    icon={ArrowRight01Icon}
                  />
                </Button>
              ))}
          {!loading && nodes.length === 0 ? (
            <p className="p-2 text-muted-foreground text-sm">
              {t("no_subdirectories")}
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} variant="ghost">
          {t("back")}
        </Button>
        <Button
          disabled={!currentPath || loading}
          onClick={() => onSelect(currentPath)}
        >
          {t("select_this_directory")}
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
  onAdd: (
    serverId: string,
    path?: string
  ) => Promise<Project | null | undefined>;
  onAdded: (project: Project) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const servers = useServers();
  const statuses = useServerStatuses();
  const [serverId, setServerId] = useState(getDefaultServerId());
  const [step, setStep] = useState<"server" | "directory">("server");
  const [error, setError] = useState("");
  const [isPicking, setIsPicking] = useState(false);
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;
  const selected =
    servers.find((server) => server.id === serverId) ?? servers[0];
  const nativePicker =
    selected?.kind === "local" && !selected.url && !!window.omoSecure;

  useEffect(() => {
    if (!open) {
      return;
    }
    setStep("server");
    setError("");
    setIsPicking(false);
    if (!servers.some((server) => server.id === serverId)) {
      setServerId(getDefaultServerId());
    }
  }, [open, servers, serverId]);

  const addFromPath = useCallback(
    async (path: string) => {
      if (!selected) {
        return;
      }
      setError("");
      try {
        const project = await onAdd(selected.id, path);
        if (project) {
          onAdded(project);
          onOpenChange(false);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [onAdd, onAdded, onOpenChange, selected]
  );

  const continueToDirectory = async () => {
    if (!selected) {
      return;
    }
    setError("");
    if (!nativePicker) {
      setStep("directory");
      return;
    }
    setIsPicking(true);
    try {
      const path = await getServerApi(selected.id).projects.pickDirectory();
      if (path) {
        await addFromPath(path);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsPicking(false);
    }
  };

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
          <DialogDescription>
            {step === "server"
              ? t("add_project_server_desc")
              : t("add_project_directory_desc")}
          </DialogDescription>
        </DialogHeader>
        {step === "server" ? (
          <>
            <DialogPanel className="flex flex-col gap-3">
              <p className="font-medium text-sm">{t("select_server")}</p>
              <div className="flex flex-col gap-2">
                {servers.map((server) => (
                  <Button
                    aria-pressed={selected?.id === server.id}
                    className="h-auto w-full justify-between px-3 py-3"
                    key={server.id}
                    onClick={() => setServerId(server.id)}
                    variant={
                      selected?.id === server.id ? "secondary" : "outline"
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <HugeiconsIcon icon={PiIcon} />
                      <span className="truncate">{serverLabel(server.id)}</span>
                    </span>
                    <ServerStatusBadge status={statuses[server.id]} />
                  </Button>
                ))}
              </div>
              {error ? (
                <p className="text-destructive text-sm">{error}</p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} variant="ghost">
                {t("cancel")}
              </Button>
              <Button
                disabled={!selected || isPicking}
                onClick={continueToDirectory}
              >
                {isPicking ? t("loading") : t("next")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <DialogPanel className="flex flex-col gap-3">
            {selected ? (
              <DirectoryPicker
                api={getServerApi(selected.id)}
                key={selected.id}
                onCancel={() => setStep("server")}
                onSelect={addFromPath}
              />
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </DialogPanel>
        )}
      </DialogContent>
    </Dialog>
  );
}
