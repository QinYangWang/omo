import {
  Add01Icon,
  AiChat01Icon,
  Attachment01Icon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { OmoSyncClient } from "@omo/client/sync-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";

type Translate = ReturnType<typeof useI18n>["t"];
type BusyAction = "connect" | "register" | "session" | "send" | "apply";

import {
  connectRemoteDaemon,
  createDaemonSyncClient,
  type DaemonHistoryEntry,
  type DaemonModelDescriptor,
  type DaemonSessionRecord,
  type DaemonWorkspaceRecord,
  daemonAbort,
  daemonConfigure,
  daemonCreateSession,
  daemonGetDraft,
  daemonListModels,
  daemonListSessions,
  daemonListWorkspaces,
  daemonPrompt,
  daemonPutDraft,
  daemonReadHistory,
  daemonRegisterWorkspace,
  daemonUploadArtifact,
  disconnectRemoteDaemon,
  getDaemonClient,
  getRemoteDaemonConfig,
} from "@/lib/omo-v2";

/**
 * v2 session surface (plan §12.2 steps 3–4, P2): the first client surface
 * driven entirely by the daemon protocol — sessions from the catalog,
 * prompts as durable commands (with image artifacts), model/thinking via
 * session.configure at the next-run boundary, live state from the WSS
 * session channel, history from the pagination projection, drafts online-
 * saved with CAS. v1 pi:* IPC is not touched here.
 *
 * Off the desktop bridge it offers remote-daemon pairing (URL + bootstrap
 * code) — never a cached offline session (§4.3).
 */

type Block =
  | { text: string; type: "text" }
  | { thinking: string; type: "thinking" }
  | { id: string; name: string; argumentsText: string; type: "toolCall" }
  | { data: string; mimeType: string; type: "image" };

interface MessageBody {
  content?: unknown;
  role?: string;
  toolName?: string;
}

const entryBlocks = (entry: DaemonHistoryEntry): Block[] => {
  const body = entry.body as MessageBody;
  const content = Array.isArray(body.content) ? body.content : [];
  const blocks: Block[] = [];
  for (const raw of content) {
    const block = raw as {
      arguments?: unknown;
      data?: string;
      mimeType?: string;
      name?: string;
      text?: string;
      thinking?: string;
      type?: string;
      id?: string;
    };
    if (block.type === "text" && block.text) {
      blocks.push({ text: block.text, type: "text" });
    } else if (block.type === "thinking" && block.thinking) {
      blocks.push({ thinking: block.thinking, type: "thinking" });
    } else if (block.type === "toolCall" && block.name) {
      blocks.push({
        argumentsText: JSON.stringify(block.arguments ?? {}),
        id: block.id ?? "",
        name: block.name,
        type: "toolCall",
      });
    } else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({
        data: block.data,
        mimeType: block.mimeType,
        type: "image",
      });
    }
  }
  return blocks;
};

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

interface Attachment {
  readonly artifactId: string;
  readonly name: string;
}

/** One transcript entry: role styling + typed content blocks. */
function HistoryEntry({
  entry,
  t,
}: {
  readonly entry: DaemonHistoryEntry;
  readonly t: Translate;
}) {
  if (entry.type === "compaction") {
    const compaction = entry.body as { tokensBefore?: number };
    return (
      <div className="py-1 text-center text-muted-foreground text-xs">
        {t("daemon_compacted", {
          tokens: String(compaction.tokensBefore ?? 0),
        })}
      </div>
    );
  }
  if (entry.type !== "message") {
    return null;
  }
  const body = entry.body as MessageBody;
  const role = body.role ?? "unknown";
  const blocks = entryBlocks(entry);
  if (blocks.length === 0) {
    return null;
  }
  const label =
    role === "toolResult"
      ? `${t("daemon_tool_result")} · ${body.toolName ?? ""}`
      : role;
  let tone: string;
  if (role === "user") {
    tone = "ml-8 bg-accent text-accent-foreground";
  } else if (role === "assistant") {
    tone = "mr-8 bg-muted/60 text-foreground";
  } else {
    tone = "mr-8 border border-border text-foreground";
  }
  return (
    <div className={`flex flex-col gap-1 rounded-lg px-3 py-2 text-sm ${tone}`}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {blocks.map((block, index) => (
        <EntryBlock
          block={block}
          // Append-only transcript blocks: positional keys are stable here.
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript block order is stable
          key={`${entry.id}:${block.type}:${index}`}
          t={t}
        />
      ))}
    </div>
  );
}

/** One typed content block inside a message entry. */
function EntryBlock({
  block,
  t,
}: {
  readonly block: Block;
  readonly t: Translate;
}) {
  if (block.type === "thinking") {
    return (
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">
          {t("daemon_thinking_block")}
        </summary>
        <p className="mt-1 whitespace-pre-wrap">{block.thinking}</p>
      </details>
    );
  }
  if (block.type === "toolCall") {
    return (
      <div className="rounded border border-border bg-background/60 px-2 py-1 font-mono text-xs">
        <span className="text-info">{block.name}</span>{" "}
        <span className="break-all text-muted-foreground">
          {block.argumentsText.length > 300
            ? `${block.argumentsText.slice(0, 300)}…`
            : block.argumentsText}
        </span>
      </div>
    );
  }
  if (block.type === "image") {
    return (
      // Transcript images are ephemeral chat content; intrinsic size is
      // unknown until load, so layout shift is accepted by design.
      // biome-ignore lint/correctness/useImageSize: chat attachment thumbnails
      <img
        alt="attachment"
        className="max-h-64 w-fit rounded border border-border"
        src={`data:${block.mimeType};base64,${block.data}`}
      />
    );
  }
  return <span className="whitespace-pre-wrap">{block.text}</span>;
}

function DaemonBackButton({
  className,
  onBack,
}: {
  readonly className?: string;
  readonly onBack?: () => void;
}) {
  const { t } = useI18n();
  if (!onBack) {
    return null;
  }
  return (
    <Button className={className} onClick={onBack} variant="ghost">
      {t("back")}
    </Button>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: session orchestration keeps the v2 view's protocol actions together
export function DaemonSessionsView({
  onBack,
}: {
  readonly onBack?: () => void;
}) {
  const { t } = useI18n();
  const [available, setAvailable] = useState<"unknown" | "yes" | "no">(
    "unknown"
  );
  const [remoteUrl, setRemoteUrl] = useState(
    () => window.__OMO_DAEMON_URL__ ?? ""
  );
  const [remoteCode, setRemoteCode] = useState("");
  const [remoteServer, setRemoteServer] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<
    readonly DaemonWorkspaceRecord[]
  >([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<readonly DaemonSessionRecord[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [entries, setEntries] = useState<readonly DaemonHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [models, setModels] = useState<readonly DaemonModelDescriptor[]>([]);
  const [currentModel, setCurrentModel] = useState<string>("");
  const [currentThinking, setCurrentThinking] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const syncRef = useRef<OmoSyncClient | null>(null);
  const subscriptionRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Availability: desktop bridge OR a previously paired remote daemon.
  useEffect(() => {
    getDaemonClient().then((handle) => {
      setAvailable(handle ? "yes" : "no");
      setRemoteServer(getRemoteDaemonConfig()?.serverId ?? null);
    });
  }, []);

  // Load workspaces + models once available.
  useEffect(() => {
    if (available !== "yes") {
      return;
    }
    daemonListWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        setWorkspaceId((current) => current || (list[0]?.workspaceId ?? ""));
      })
      .catch((cause) => setError(String(cause)));
    daemonListModels()
      .then(setModels)
      .catch(() => undefined);
  }, [available]);

  // Sessions follow the selected workspace.
  useEffect(() => {
    if (!workspaceId) {
      setSessions([]);
      return;
    }
    daemonListSessions(workspaceId)
      .then(setSessions)
      .catch((cause) => setError(String(cause)));
  }, [workspaceId]);

  const refreshHistoryTail = useCallback(async (id: string) => {
    const page = await daemonReadHistory(id, { limit: 500 });
    setEntries(page.entries);
    setNextCursor(page.nextCursor);
  }, []);

  // Session channel: live lane state + committed command transitions.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let disposed = false;
    const wire = async () => {
      const sync = await createDaemonSyncClient();
      if (!sync || disposed) {
        return;
      }
      syncRef.current = sync;
      subscriptionRef.current = sync.subscribe(`session:${sessionId}`, {
        onFrame: (frame) => {
          if (frame.kind === "lane.event") {
            const payload = frame.payload as {
              snapshot?: {
                model?: { modelId: string; provider: string };
                operation?: { operationId: string } | null;
              };
            };
            setRunning(payload.snapshot?.operation?.operationId ?? null);
            if (payload.snapshot?.model) {
              setCurrentModel(
                `${payload.snapshot.model.provider}/${payload.snapshot.model.modelId}`
              );
            }
            return;
          }
          if (frame.kind === "command.updated") {
            const payload = frame.payload as {
              command?: { state?: string };
            };
            if (
              payload.command?.state === "completed" ||
              payload.command?.state === "failed" ||
              payload.command?.state === "cancelled"
            ) {
              refreshHistoryTail(sessionId).catch(() => undefined);
            }
          }
        },
        onReset: () => {
          refreshHistoryTail(sessionId).catch(() => undefined);
        },
        onSnapshot: () => {
          refreshHistoryTail(sessionId).catch(() => undefined);
        },
      });
      await sync.connect();
      if (disposed) {
        sync.close();
      }
    };
    wire().catch((cause) => setError(String(cause)));
    return () => {
      disposed = true;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: assigned in wire() after cleanup may have run
      if (syncRef.current && subscriptionRef.current) {
        syncRef.current.unsubscribe(subscriptionRef.current);
        syncRef.current.close();
      }
      syncRef.current = null;
      subscriptionRef.current = null;
    };
  }, [sessionId, refreshHistoryTail]);

  // History + draft on open.
  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setComposer("");
      setAttachments([]);
      return;
    }
    refreshHistoryTail(sessionId).catch(() => undefined);
    daemonGetDraft(sessionId)
      .then(setComposer)
      .catch(() => undefined);
  }, [sessionId, refreshHistoryTail]);

  // Drafts: debounced online save (§6.1; never an offline execution queue).
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const timer = setTimeout(() => {
      daemonPutDraft(sessionId, composer).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [composer, sessionId]);

  const connectRemote = async () => {
    setBusyAction("connect");
    setError(null);
    try {
      const config = await connectRemoteDaemon(
        remoteUrl.trim(),
        remoteCode.trim()
      );
      setRemoteServer(config.serverId);
      setAvailable("yes");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const createSession = async () => {
    if (!workspaceId) {
      return;
    }
    setBusyAction("session");
    setError(null);
    try {
      const created = await daemonCreateSession(workspaceId);
      setSessions((current) => [...current, created]);
      setSessionId(created.sessionId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const registerWorkspace = async () => {
    if (!newWorkspacePath.trim()) {
      return;
    }
    setBusyAction("register");
    setError(null);
    try {
      const workspace = await daemonRegisterWorkspace(newWorkspacePath.trim());
      setWorkspaces((current) => [...current, workspace]);
      setNewWorkspacePath("");
      setWorkspaceId(workspace.workspaceId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const attachFiles = async (files: FileList | null) => {
    if (!files) {
      return;
    }
    setError(null);
    for (const file of Array.from(files)) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: uploads stay ordered
        const bytes = new Uint8Array(await file.arrayBuffer());
        const artifact = await daemonUploadArtifact(bytes, {
          mime: file.type || "application/octet-stream",
          name: file.name,
        });
        setAttachments((current) => [
          ...current,
          { artifactId: artifact.artifactId, name: file.name },
        ]);
      } catch (cause) {
        setError(String(cause));
      }
    }
  };

  const sendPrompt = async () => {
    const text = composer.trim();
    if (!(text && sessionId && workspaceId)) {
      return;
    }
    setBusyAction("send");
    setError(null);
    try {
      const receipt = await daemonPrompt(
        workspaceId,
        sessionId,
        text,
        attachments.map((attachment) => attachment.artifactId)
      );
      setComposer("");
      setAttachments([]);
      setRunning(receipt.operationId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const abort = async () => {
    if (running && workspaceId && sessionId) {
      await daemonAbort(workspaceId, sessionId, running).catch((cause) =>
        setError(String(cause))
      );
    }
  };

  const applyModel = async () => {
    if (!(sessionId && workspaceId)) {
      return;
    }
    const [provider, ...rest] = currentModel.split("/");
    const modelId = rest.join("/");
    setBusyAction("apply");
    setError(null);
    try {
      await daemonConfigure(workspaceId, sessionId, {
        model: provider && modelId ? { modelId, provider } : undefined,
        thinkingLevel: currentThinking || undefined,
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const loadOlder = async () => {
    if (!(nextCursor && sessionId)) {
      return;
    }
    const page = await daemonReadHistory(sessionId, { limit: 500 });
    setEntries(page.entries);
    setNextCursor(page.nextCursor);
  };

  if (available === "no") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-sidebar p-6 text-foreground">
        <h2 className="font-medium text-xl">{t("daemon_sessions_title")}</h2>
        <p className="max-w-md text-center text-muted-foreground text-sm">
          {t("daemon_remote_desc")}
        </p>
        <div className="flex w-full max-w-md flex-col gap-2">
          <Input
            aria-label={t("daemon_remote_url")}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder={t("daemon_remote_url")}
            value={remoteUrl}
          />
          <Input
            aria-label={t("daemon_remote_code")}
            onChange={(event) => setRemoteCode(event.target.value)}
            placeholder={t("daemon_remote_code")}
            value={remoteCode}
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          <div className="flex gap-2">
            <Button
              disabled={!(remoteUrl.trim() && remoteCode.trim())}
              loading={busyAction === "connect"}
              onClick={connectRemote}
            >
              {t("daemon_remote_connect")}
            </Button>
            <DaemonBackButton onBack={onBack} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-sidebar text-foreground">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-sidebar-border border-r">
          <div className="flex items-center justify-between gap-2 p-2">
            <span className="font-medium text-sidebar-foreground text-sm">
              {t("daemon_sessions_title")}
            </span>
            <Button
              aria-label={t("daemon_new_session")}
              className="size-7"
              disabled={!workspaceId || !!busyAction}
              loading={busyAction === "session"}
              onClick={createSession}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={Add01Icon} />
            </Button>
          </div>
          <div className="flex flex-col gap-2 px-2 pb-2">
            <Select
              onValueChange={(value) => setWorkspaceId(value ?? "")}
              value={workspaceId}
            >
              <SelectTrigger aria-label={t("daemon_workspace")} className="h-8">
                <SelectValue placeholder={t("daemon_workspace")} />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((workspace) => (
                  <SelectItem
                    key={workspace.workspaceId}
                    value={workspace.workspaceId}
                  >
                    {workspace.name ?? workspace.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1">
              <Input
                aria-label={t("daemon_register_workspace")}
                className="h-8 text-xs"
                onChange={(event) => setNewWorkspacePath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    registerWorkspace().catch(() => undefined);
                  }
                }}
                placeholder={t("daemon_workspace_path")}
                value={newWorkspacePath}
              />
              <Button
                aria-label={t("daemon_register_workspace")}
                className="size-8 shrink-0"
                disabled={!newWorkspacePath.trim() || !!busyAction}
                loading={busyAction === "register"}
                onClick={registerWorkspace}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon className="size-4" icon={Add01Icon} />
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {sessions.length === 0 ? (
                <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                  {t("daemon_empty_sessions")}
                </p>
              ) : (
                sessions.map((session) => (
                  <Button
                    className={`h-8 justify-start gap-2 px-2 font-normal text-xs ${
                      session.sessionId === sessionId
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground"
                    }`}
                    key={session.sessionId}
                    onClick={() => setSessionId(session.sessionId)}
                    variant="ghost"
                  >
                    <HugeiconsIcon
                      className="size-3.5 shrink-0"
                      icon={AiChat01Icon}
                    />
                    <span className="truncate">
                      {session.name ?? session.sessionId}
                    </span>
                  </Button>
                ))
              )}
            </div>
          </ScrollArea>
          <div className="flex flex-col gap-1 p-2">
            {remoteServer ? (
              <Button
                className="h-8 w-full justify-start gap-2 px-2 font-normal text-sidebar-foreground hover:bg-sidebar-accent"
                onClick={() => {
                  disconnectRemoteDaemon();
                  setAvailable("no");
                  setRemoteServer(null);
                }}
                variant="ghost"
              >
                {t("daemon_remote_disconnect")}
              </Button>
            ) : null}
            <DaemonBackButton
              className="h-8 w-full justify-start gap-2 px-2 font-normal text-sidebar-foreground hover:bg-sidebar-accent"
              onBack={onBack}
            />
          </div>
        </div>

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {error ? (
            <div className="border-destructive/40 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}
          {sessionId ? (
            <div className="flex items-center gap-2 border-sidebar-border border-b px-4 py-1.5">
              <Select
                onValueChange={(value) => setCurrentModel(value ?? "")}
                value={currentModel}
              >
                <SelectTrigger
                  aria-label={t("daemon_model")}
                  className="h-7 max-w-64 text-xs"
                >
                  <SelectValue placeholder={t("daemon_model")} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => {
                    const value = `${model.provider}/${model.modelId}`;
                    return (
                      <SelectItem key={value} value={value}>
                        {model.name ?? value}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) => setCurrentThinking(value ?? "")}
                value={currentThinking}
              >
                <SelectTrigger
                  aria-label={t("daemon_thinking")}
                  className="h-7 w-32 text-xs"
                >
                  <SelectValue placeholder={t("daemon_thinking")} />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="h-7 px-2 text-xs"
                disabled={!(currentModel || currentThinking) || !!busyAction}
                loading={busyAction === "apply"}
                onClick={applyModel}
                variant="ghost"
              >
                {t("daemon_apply_model")}
              </Button>
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
              {sessionId ? (
                <>
                  {nextCursor ? (
                    <Button
                      className="self-center"
                      onClick={loadOlder}
                      size="sm"
                      variant="ghost"
                    >
                      {t("daemon_load_older")}
                    </Button>
                  ) : null}
                  {entries.map((entry) => (
                    <HistoryEntry entry={entry} key={entry.id} t={t} />
                  ))}
                  {running ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
                      <Spinner className="size-3.5" />
                      {t("daemon_running")}
                      <Button
                        className="h-6 gap-1 px-2 text-xs"
                        onClick={abort}
                        size="sm"
                        variant="ghost"
                      >
                        <HugeiconsIcon
                          className="size-3.5"
                          icon={StopCircleIcon}
                        />
                        {t("daemon_abort")}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="py-16 text-center text-muted-foreground text-sm">
                  {t("daemon_select_session")}
                </p>
              )}
            </div>
          </ScrollArea>
          {sessionId ? (
            <div className="border-sidebar-border border-t p-3">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                {attachments.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {attachments.map((attachment) => (
                      <Badge
                        className="gap-1"
                        key={attachment.artifactId}
                        variant="secondary"
                      >
                        {attachment.name}
                        <button
                          aria-label={t("daemon_remove_attachment")}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setAttachments((current) =>
                              current.filter(
                                (item) =>
                                  item.artifactId !== attachment.artifactId
                              )
                            )
                          }
                          type="button"
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <input
                    accept="image/*"
                    className="hidden"
                    multiple
                    onChange={(event) => {
                      attachFiles(event.target.files).catch((cause) =>
                        setError(String(cause))
                      );
                      event.target.value = "";
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Button
                    aria-label={t("daemon_attach")}
                    className="size-10 shrink-0"
                    onClick={() => fileInputRef.current?.click()}
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-4" icon={Attachment01Icon} />
                  </Button>
                  <Textarea
                    aria-label={t("daemon_composer")}
                    className="min-h-10 flex-1 resize-none"
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault();
                        sendPrompt().catch(() => undefined);
                      }
                    }}
                    placeholder={t("daemon_composer")}
                    rows={2}
                    value={composer}
                  />
                  <Button
                    className="h-10 gap-1.5"
                    disabled={!composer.trim() || !!running || !!busyAction}
                    loading={busyAction === "send"}
                    onClick={() => sendPrompt().catch(() => undefined)}
                  >
                    {t("daemon_send")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
