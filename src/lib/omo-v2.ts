import { OmoClient } from "@omo/client/client";
import type { OmoSyncClient } from "@omo/client/sync-client";
import { randomUUID } from "@/lib/utils";

/**
 * v2 daemon client entry for the renderer (plan §4.2, §12.2; AGENTS.md: 业务组件
 * 统一通过 src/lib 入口访问后端，不直接新增 window 调用).
 *
 * The desktop main process supervises the daemon and holds the
 * safeStorage-protected device token; the renderer receives a ready-to-use
 * connection config over IPC. In pure Web mode (no Electron bridge), the
 * pairing screen exchanges a bootstrap code for the same device token and
 * then stores only that revocable token.
 */

export interface DaemonConnectionConfig {
  readonly baseUrl: string;
  readonly serverId: string;
  readonly token: string;
  readonly wsUrl: string;
}

export interface DaemonStateEvent {
  readonly error: string | null;
  readonly state: "failed" | "ready" | "starting" | "stopped";
}

declare global {
  interface Window {
    omoDaemon?: {
      readonly config: () => Promise<DaemonConnectionConfig | null>;
      readonly onState: (cb: (event: DaemonStateEvent) => void) => () => void;
    };
  }
}

interface DaemonClientHandle {
  readonly client: OmoClient;
  readonly config: DaemonConnectionConfig;
}

let cached: Promise<DaemonClientHandle | null> | undefined;

// ------------------------------------------------------ remote daemon (Web)
// §10.1 custody note: the stored credential is a REVOCABLE device token,
// never the bootstrap pairing code; transport must be HTTPS off loopback.
const REMOTE_KEY = "omo:v2:remote-daemon";
const HTTP_SCHEME = /^http/;
const TRAILING_SLASHES = /\/+$/;

const normalizeDaemonUrl = (value: string): string =>
  value.trim().replace(TRAILING_SLASHES, "");

interface RemoteDaemonConfig {
  readonly baseUrl: string;
  readonly serverId?: string;
  readonly token: string;
}

const readRemoteConfig = (): RemoteDaemonConfig | null => {
  try {
    const raw = localStorage.getItem(REMOTE_KEY);
    return raw ? (JSON.parse(raw) as RemoteDaemonConfig) : null;
  } catch {
    return null;
  }
};

/** Pair with a remote daemon (URL + bootstrap code) and persist the device. */
export const connectRemoteDaemon = async (
  baseUrl: string,
  pairingCode: string
): Promise<DaemonConnectionConfig> => {
  const client = await OmoClient.pair(baseUrl, pairingCode, "omo web");
  const hello = (await client.hello()) as {
    identity: { serverId: string };
  };
  const config: RemoteDaemonConfig = {
    baseUrl: client.baseUrl,
    serverId: hello.identity.serverId,
    token: client.token,
  };
  localStorage.setItem(REMOTE_KEY, JSON.stringify(config));
  cached = undefined;
  return {
    baseUrl: config.baseUrl,
    serverId: config.serverId ?? "",
    token: config.token,
    wsUrl: `${config.baseUrl.replace(HTTP_SCHEME, "ws")}/v1/sync`,
  };
};

export const disconnectRemoteDaemon = (): void => {
  localStorage.removeItem(REMOTE_KEY);
  cached = undefined;
};

export const getRemoteDaemonConfig = (): RemoteDaemonConfig | null =>
  readRemoteConfig();

/** The paired client for the supervised local daemon, or null off-desktop. */
export const getDaemonClient = (): Promise<DaemonClientHandle | null> => {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.omoDaemon;
  if (!bridge) {
    // Web mode: a previously paired remote daemon (§10.1 custody note above).
    const remote = readRemoteConfig();
    const hostedDaemonUrl = window.__OMO_DAEMON_URL__;
    if (
      !remote ||
      (hostedDaemonUrl &&
        normalizeDaemonUrl(remote.baseUrl) !==
          normalizeDaemonUrl(hostedDaemonUrl))
    ) {
      return Promise.resolve(null);
    }
    cached ??= Promise.resolve({
      client: new OmoClient({
        baseUrl: remote.baseUrl,
        token: remote.token,
      }),
      config: {
        baseUrl: remote.baseUrl,
        serverId: remote.serverId ?? "",
        token: remote.token,
        wsUrl: `${remote.baseUrl.replace(HTTP_SCHEME, "ws")}/v1/sync`,
      },
    });
    return cached;
  }
  cached ??= bridge.config().then((config) =>
    config
      ? {
          client: new OmoClient({
            baseUrl: config.baseUrl,
            token: config.token,
          }),
          config,
        }
      : null
  );
  return cached;
};

/** A sync client wired to the supervised daemon (ticket auto-issued). */
export const createDaemonSyncClient =
  async (): Promise<OmoSyncClient | null> => {
    const handle = await getDaemonClient();
    if (!handle) {
      return null;
    }
    return handle.client.createSyncClient({ url: handle.config.wsUrl });
  };

/** Subscribe to main-process daemon lifecycle state. */
export const onDaemonState = (
  cb: (event: DaemonStateEvent) => void
): (() => void) => window.omoDaemon?.onState(cb) ?? (() => undefined);

// ------------------------------------------------------------------ sessions
// The v2 session surface (plan §12.2 steps 3–4): every operation below goes
// through the daemon's durable command / query protocol — never through v1
// pi:* IPC. Commands are idempotent by clientMutationId + commandId.

export interface DaemonWorkspaceRecord {
  readonly createdAt: string;
  readonly name?: string;
  readonly path: string;
  readonly workspaceId: string;
}

export interface DaemonSessionRecord {
  readonly createdAt: string;
  readonly name?: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface DaemonHistoryEntry {
  readonly body: unknown;
  readonly id: string;
  readonly parentId: string | null;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
}

const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

export const daemonListWorkspaces = async (): Promise<
  readonly DaemonWorkspaceRecord[]
> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return [];
  }
  const body = (await handle.client.listWorkspaces()) as {
    workspaces: DaemonWorkspaceRecord[];
  };
  return body.workspaces;
};

export const daemonRegisterWorkspace = async (
  path: string,
  name?: string
): Promise<DaemonWorkspaceRecord> => {
  const handle = await getDaemonClient();
  if (!handle) {
    throw new Error("daemon unavailable");
  }
  const body = (await handle.client.registerWorkspace(path, name)) as {
    workspace: DaemonWorkspaceRecord;
  };
  return body.workspace;
};

export const daemonListSessions = async (
  workspaceId?: string
): Promise<readonly DaemonSessionRecord[]> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return [];
  }
  const body = (await handle.client.listSessions(workspaceId)) as {
    sessions: DaemonSessionRecord[];
  };
  return body.sessions;
};

/** session.create is a durable command; completion is polled by command id. */
export const daemonCreateSession = async (
  workspaceId: string,
  name?: string
): Promise<DaemonSessionRecord> => {
  const handle = await getDaemonClient();
  if (!handle) {
    throw new Error("daemon unavailable");
  }
  const commandId = newId("cmd");
  await handle.client.submitCommand({
    clientMutationId: newId("mut"),
    commandId,
    kind: "session.create",
    payload: name ? { name } : {},
    scope: { workspaceId },
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional receipt polling
    const body = (await handle.client.getCommand(commandId)) as {
      command: {
        result?: { sessionId?: string };
        state: string;
        error?: { message?: string };
      };
    };
    if (body.command.state === "completed" && body.command.result?.sessionId) {
      return {
        createdAt: new Date().toISOString(),
        name,
        sessionId: body.command.result.sessionId,
        workspaceId,
      };
    }
    if (body.command.state === "failed") {
      throw new Error(
        body.command.error?.message ?? "session.create failed on the daemon"
      );
    }
    if (Date.now() > deadline) {
      throw new Error("session.create timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export interface DaemonPromptReceipt {
  readonly commandId: string;
  readonly operationId: string;
}

export const daemonPrompt = async (
  workspaceId: string,
  sessionId: string,
  prompt: string,
  artifactIds?: readonly string[]
): Promise<DaemonPromptReceipt> => {
  const handle = await getDaemonClient();
  if (!handle) {
    throw new Error("daemon unavailable");
  }
  const body = await handle.client.submitCommand({
    clientMutationId: newId("mut"),
    commandId: newId("cmd"),
    kind: "prompt",
    payload: {
      prompt,
      ...(artifactIds && artifactIds.length > 0 ? { artifactIds } : {}),
    },
    scope: { laneId: "main", sessionId, workspaceId },
  });
  const { receipt } = body as {
    receipt: { commandId: string; operationId?: string };
  };
  if (!receipt.operationId) {
    throw new Error("daemon did not assign an operation id");
  }
  return { commandId: receipt.commandId, operationId: receipt.operationId };
};

export const daemonAbort = async (
  workspaceId: string,
  sessionId: string,
  operationId: string
): Promise<void> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return;
  }
  await handle.client.submitCommand({
    clientMutationId: newId("mut"),
    commandId: newId("cmd"),
    expectedOperationId: operationId,
    kind: "operation.abort",
    payload: { operationId },
    scope: { sessionId, workspaceId },
  });
};

export const daemonReadHistory = async (
  sessionId: string,
  options?: { cursor?: string; limit?: number }
): Promise<{
  readonly entries: readonly DaemonHistoryEntry[];
  readonly nextCursor: string | null;
}> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return { entries: [], nextCursor: null };
  }
  return (await handle.client.readHistory(sessionId, options)) as {
    entries: DaemonHistoryEntry[];
    nextCursor: string | null;
  };
};

export const daemonGetDraft = async (sessionId: string): Promise<string> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return "";
  }
  const body = (await handle.client.getDraft(sessionId)) as {
    draft: { body: string } | null;
  };
  return body.draft?.body ?? "";
};

export const daemonPutDraft = async (
  sessionId: string,
  body: string
): Promise<void> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return;
  }
  // First write: revision 0 expectation; conflicts are resolved by re-read.
  const current = (await handle.client.getDraft(sessionId)) as {
    draft: { revision: number } | null;
  };
  try {
    await handle.client.putDraft(sessionId, body, current.draft?.revision ?? 0);
  } catch {
    // CAS conflict: a newer draft exists on another device — keep local text.
  }
};

// ---------------------------------------------------------------- models/configure

export interface DaemonModelDescriptor {
  readonly modelId: string;
  readonly name?: string;
  readonly provider: string;
}

export const daemonListModels = async (): Promise<
  readonly DaemonModelDescriptor[]
> => {
  const handle = await getDaemonClient();
  if (!handle) {
    return [];
  }
  const body = (await handle.client.listModels()) as {
    models: DaemonModelDescriptor[];
  };
  return body.models;
};

/** §6.6: model / thinking changes apply at the next-run boundary. */
export const daemonConfigure = async (
  workspaceId: string,
  sessionId: string,
  patch: {
    readonly model?: { modelId: string; provider: string };
    readonly thinkingLevel?: string;
  }
): Promise<void> => {
  const handle = await getDaemonClient();
  if (!handle) {
    throw new Error("daemon unavailable");
  }
  await handle.client.submitCommand({
    clientMutationId: newId("mut"),
    commandId: newId("cmd"),
    kind: "session.configure",
    payload: patch,
    scope: { sessionId, workspaceId },
  });
};

// ------------------------------------------------------------------ artifacts

export const daemonUploadArtifact = async (
  bytes: Uint8Array,
  meta?: { mime?: string; name?: string }
): Promise<{ artifactId: string; sha256: string; size: number }> => {
  const handle = await getDaemonClient();
  if (!handle) {
    throw new Error("daemon unavailable");
  }
  const body = (await handle.client.uploadArtifact(bytes, meta)) as {
    artifact: { artifactId: string; sha256: string; size: number };
  };
  return body.artifact;
};
