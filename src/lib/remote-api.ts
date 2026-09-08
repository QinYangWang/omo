import { randomUUID } from "@/lib/utils";

const trailingSlash = /\/$/;
const httpScheme = /^http:/;
const httpsScheme = /^https:/;
const sseLineEndings = /\r\n/g;

type EventCallback = (data: OmoPiEventEnvelope) => void;

interface RemoteTerminal {
  cols: number;
  id: string;
  listeners: Set<(data: string) => void>;
  offset: number;
  reconnect?: ReturnType<typeof setTimeout>;
  retry: number;
  rows: number;
  socket?: WebSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function handleRemoteTerminalMessage(
  terminal: RemoteTerminal,
  payload: unknown
): void {
  if (!isRecord(payload)) {
    return;
  }
  if (payload.type === "exit") {
    terminal.id = "";
    return;
  }
  if (payload.type === "reset" && typeof payload.offset === "number") {
    terminal.offset = payload.offset;
    for (const listener of terminal.listeners) {
      listener("\u001bc");
    }
    return;
  }
  if (
    payload.type !== "output" ||
    typeof payload.nextOffset !== "number" ||
    typeof payload.offset !== "number" ||
    payload.nextOffset <= terminal.offset
  ) {
    return;
  }
  const skip = Math.max(0, terminal.offset - payload.offset);
  terminal.offset = payload.nextOffset;
  for (const listener of terminal.listeners) {
    listener(String(payload.data).slice(skip));
  }
}

function eventStreamCursor(
  sessionId: string,
  sequenceKey: string,
  firstConnection: boolean
): number {
  // Provider auth events are transient UI actions. Never replay them on the
  // initial subscription: doing so launches an old OAuth flow merely by
  // visiting Settings or switching servers. Reconnects still resume from the
  // last event so an active flow is not interrupted.
  if (firstConnection && sessionId === "__providers") {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(localStorage.getItem(sequenceKey) || 0);
}

function eventData(block: string) {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function dispatchEvent(
  sessionId: string,
  sequenceKey: string,
  data: string,
  authListeners: Set<(event: ProviderAuthEvent) => void>,
  piListeners: Set<EventCallback>
) {
  const parsed: unknown = JSON.parse(data);
  if (!isRecord(parsed) || typeof parsed.sequence !== "number") {
    return;
  }
  localStorage.setItem(sequenceKey, String(parsed.sequence));
  if (sessionId === "__providers") {
    const event = parsed.payload as ProviderAuthEvent;
    if (event.kind === "notify" && event.event.type === "auth_url") {
      window.open(event.event.url, "_blank", "noopener,noreferrer");
    }
    if (event.kind === "notify" && event.event.type === "device_code") {
      window.open(event.event.verificationUri, "_blank", "noopener,noreferrer");
    }
    for (const listener of authListeners) {
      listener(event);
    }
    return;
  }
  const event = parsed.payload as OmoPiEvent;
  for (const listener of piListeners) {
    listener({ event, sessionId });
  }
}

async function readEventStream(
  response: Response,
  signal: AbortSignal,
  sequenceKey: string,
  sessionId: string,
  authListeners: Set<(event: ProviderAuthEvent) => void>,
  piListeners: Set<EventCallback>
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read in order.
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder
      .decode(value, { stream: true })
      .replace(sseLineEndings, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = eventData(block);
      if (data) {
        dispatchEvent(sessionId, sequenceKey, data, authListeners, piListeners);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(trailingSlash, "");
}

export function createRemoteApi(baseUrl: string, token: string): omoApi {
  const base = normalizeBaseUrl(baseUrl);
  const headers = () => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const request = async <T>(route: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}/api/v1${route}`, {
      ...init,
      headers: { ...headers(), ...init?.headers },
    });
    const result: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error =
        isRecord(result) && typeof result.error === "string"
          ? result.error
          : `Server request failed (${response.status})`;
      throw new Error(error);
    }
    return result as T;
  };
  const post = <T>(route: string, value: unknown) =>
    request<T>(route, { body: JSON.stringify(value), method: "POST" });
  const query = (values: Record<string, string>) =>
    new URLSearchParams(values).toString();

  const piListeners = new Set<EventCallback>();
  const authListeners = new Set<(event: ProviderAuthEvent) => void>();
  const terminals = new Map<string, RemoteTerminal>();
  const streams = new Map<string, AbortController>();

  const getTerminal = (key: string): RemoteTerminal => {
    const existing = terminals.get(key);
    if (existing) {
      return existing;
    }
    const terminal: RemoteTerminal = {
      cols: 120,
      id: "",
      listeners: new Set(),
      offset: 0,
      retry: 1000,
      rows: 30,
    };
    terminals.set(key, terminal);
    return terminal;
  };

  const connectEvents = (sessionId: string) => {
    if (streams.has(sessionId)) {
      return;
    }
    const controller = new AbortController();
    streams.set(sessionId, controller);
    let retry = 1000;
    let firstConnection = true;

    const connectOnce = async (sequenceKey: string, after: number) => {
      const response = await fetch(
        `${base}/api/v1/events?${query({ after: String(after), sessionId })}`,
        { headers: headers(), signal: controller.signal }
      );
      if (!(response.ok && response.body)) {
        throw new Error(`Event stream failed (${response.status})`);
      }
      retry = 1000;
      await readEventStream(
        response,
        controller.signal,
        sequenceKey,
        sessionId,
        authListeners,
        piListeners
      );
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        const sequenceKey = `omo:event-sequence:${base}:${sessionId}`;
        const after = eventStreamCursor(
          sessionId,
          sequenceKey,
          firstConnection
        );
        firstConnection = false;
        try {
          // biome-ignore lint/performance/noAwaitInLoops: event streams reconnect sequentially.
          await connectOnce(sequenceKey, after);
        } catch (error) {
          if (controller.signal.aborted) {
            break;
          }
          console.warn("omo event stream reconnecting", error);
        }
        if (controller.signal.aborted) {
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, retry + Math.random() * retry * 0.2)
        );
        retry = Math.min(30_000, retry * 2);
      }
    };
    run().catch((error: unknown) =>
      console.warn("omo event stream stopped", error)
    );
  };

  const connectTerminal = (terminal: RemoteTerminal, ticket: string) => {
    if (!terminal.id) {
      return;
    }
    const wsBase = base.replace(httpScheme, "ws:").replace(httpsScheme, "wss:");
    const socket = new WebSocket(
      `${wsBase}/api/v1/terminals/${encodeURIComponent(terminal.id)}/stream?${query({ after: String(terminal.offset), ticket })}`
    );
    terminal.socket = socket;
    socket.onopen = () => {
      terminal.retry = 1000;
      socket.send(
        JSON.stringify({
          cols: terminal.cols,
          rows: terminal.rows,
          type: "resize",
        })
      );
    };
    socket.onmessage = (event) => {
      handleRemoteTerminalMessage(terminal, JSON.parse(String(event.data)));
    };
    socket.onclose = () => {
      if (terminal.id && terminal.socket === socket) {
        scheduleTerminalReconnect(terminal);
      }
    };
  };

  const scheduleTerminalReconnect = (terminal: RemoteTerminal) => {
    terminal.reconnect = setTimeout(
      async () => {
        try {
          const result = await post<{ ticket: string }>(
            `/terminals/${encodeURIComponent(terminal.id)}/ticket`,
            {}
          );
          connectTerminal(terminal, result.ticket);
        } catch (error) {
          console.warn("Remote terminal reconnecting", error);
          scheduleTerminalReconnect(terminal);
        }
      },
      terminal.retry + Math.random() * terminal.retry * 0.2
    );
    terminal.retry = Math.min(30_000, terminal.retry * 2);
  };

  return {
    cwd: async () => (await request<{ cwd: string }>("/cwd")).cwd,
    fs: {
      list: (dir) => request(`/files?${query({ path: dir })}`),
      read: (path, binary = false) =>
        request(`/files/content?${query({ binary: String(binary), path })}`),
    },
    git: {
      branches: (cwd) => request(`/git/branches?${query({ cwd })}`),
      createBranch: (cwd, name) =>
        request<{ ok: boolean; output: string }>("/git/branch", {
          body: JSON.stringify({ cwd, name }),
          method: "POST",
        }),
      diff: async (cwd, file) =>
        (await request<{ output: string }>(`/git/diff?${query({ cwd, file })}`))
          .output,
      status: async (cwd) =>
        (await request<{ output: string }>(`/git/status?${query({ cwd })}`))
          .output,
    },
    models: {
      list: () => request("/models"),
      setEnabled: (enabled) => post("/models", { enabled }),
    },
    packages: {
      install: (source) => post("/packages/install", { source }),
      list: () => request("/packages"),
      remove: (source) => post("/packages/remove", { source }),
    },
    pi: {
      abort: async (sessionId) => {
        await post("/pi/abort", { sessionId });
      },
      branch: (sessionId, entryId) =>
        post("/pi/branch", { entryId, sessionId }),
      commands: (sessionId, cwd, sessionPath) =>
        post("/pi/commands", { cwd, sessionId, sessionPath }),
      contextUsage: (sessionId, cwd, sessionPath) =>
        post("/pi/context-usage", { cwd, sessionId, sessionPath }),
      history: (sessionId, before) =>
        post("/pi/history", { before, sessionId }),
      models: () => request("/pi/models"),
      onEvent: (callback) => {
        piListeners.add(callback);
        return () => piListeners.delete(callback);
      },
      open: async (sessionId, cwd, sessionPath) => {
        const result = await post<{
          cursor: number;
          eventSequence?: number;
          hasMore: boolean;
          messages: unknown[];
          outline?: {
            absoluteIndex: number;
            id: string;
            userPreview: string;
          }[];
          contextUsage?: PiContextUsage | null;
          model?: { id: string; name: string; provider: string } | null;
          thinkingLevel?: string;
          isStreaming?: boolean;
          replayFromSequence?: number;
        }>("/pi/open", {
          cwd,
          sessionId,
          sessionPath,
        });
        const sequenceKey = `omo:event-sequence:${base}:${sessionId}`;
        const storedSequence = Number(localStorage.getItem(sequenceKey) || 0);
        if (typeof result.replayFromSequence === "number") {
          localStorage.setItem(
            sequenceKey,
            String(Math.min(storedSequence, result.replayFromSequence))
          );
        } else if (
          typeof result.eventSequence === "number" &&
          !localStorage.getItem(sequenceKey)
        ) {
          localStorage.setItem(sequenceKey, String(result.eventSequence));
        }
        connectEvents(sessionId);
        return result;
      },
      prompt: async (sessionId, message, cwd, sessionPath, images) => {
        const result = await post<{
          sessionFile?: string;
          sessionId?: string;
        }>("/pi/prompt", {
          cwd,
          images,
          message,
          requestId: randomUUID(),
          sessionId,
          sessionPath,
        });
        return result;
      },
      release: async () => undefined,
      retain: async () => undefined,
      setModel: async (sessionId, provider, modelId) => {
        await post("/pi/model", { modelId, provider, sessionId });
      },
      setThinking: async (sessionId, level) => {
        await post("/pi/thinking", { level, sessionId });
      },
      sync: (sessionId, sessionPath, turnCount, tailItemCount) =>
        post("/pi/sync", { sessionId, sessionPath, tailItemCount, turnCount }),
    },
    projects: {
      add: (path?: string) =>
        path ? post("/projects", { cwd: path }) : Promise.resolve(null),
      list: () => request("/projects"),
      pickDirectory: async () => null,
    },
    providers: {
      cancel: (requestId) => post("/providers/cancel", { requestId }),
      list: () => request("/providers"),
      login: (providerId, type) =>
        post("/providers/login", { providerId, type }),
      logout: (providerId) => post("/providers/logout", { providerId }),
      onAuthEvent: (callback) => {
        authListeners.add(callback);
        connectEvents("__providers");
        return () => authListeners.delete(callback);
      },
      quotas: (force = false) => request(`/quotas?force=${force}`),
      respond: (requestId, value) =>
        post("/providers/respond", { requestId, value }),
    },
    sessions: {
      all: () => request("/sessions/all"),
      clone: async (sessionPath) =>
        (await post<{ path: string }>("/sessions/clone", { path: sessionPath }))
          .path,
      context: async (sessionPath) =>
        (
          await request<{ markdown: string }>(
            `/sessions/context?${query({ path: sessionPath })}`
          )
        ).markdown,
      details: (sessionPath, cwd) =>
        request(`/sessions/details?${query({ cwd, path: sessionPath })}`),
      import: async (sourcePath, cwd) =>
        (await post<{ path: string }>("/sessions/import", { cwd, sourcePath }))
          .path,
      list: (cwd) => request(`/sessions?${query({ cwd })}`),
      rename: async (sessionPath, name) => {
        await post("/sessions/rename", { name, path: sessionPath });
        return true;
      },
    },
    skills: { list: () => request("/skills") },
    term: {
      close: async (key = "default") => {
        const terminal = terminals.get(key);
        if (!terminal) {
          return;
        }
        if (terminal.reconnect) {
          clearTimeout(terminal.reconnect);
        }
        const previousId = terminal.id;
        terminal.id = "";
        terminal.socket?.close();
        terminals.delete(key);
        if (previousId) {
          await request(`/terminals/${encodeURIComponent(previousId)}`, {
            method: "DELETE",
          });
        }
      },
      create: async (cwd, cols = 120, rows = 30, key = "default") => {
        const terminal = getTerminal(key);
        terminal.cols = cols;
        terminal.rows = rows;
        if (terminal.id && terminal.socket?.readyState !== WebSocket.CLOSED) {
          return;
        }
        if (terminal.reconnect) {
          clearTimeout(terminal.reconnect);
        }
        const result = await post<{
          terminalId: string;
          offset: number;
          ticket: string;
        }>("/terminals", { cols, cwd, rows });
        terminal.id = result.terminalId;
        terminal.offset = result.offset;
        connectTerminal(terminal, result.ticket);
      },
      input: (data, key = "default") => {
        const { socket } = getTerminal(key);
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ data, type: "input" }));
        }
      },
      onData: (callback, key = "default") => {
        const { listeners } = getTerminal(key);
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      resize: (cols, rows, key = "default") => {
        const terminal = getTerminal(key);
        terminal.cols = cols;
        terminal.rows = rows;
        if (terminal.socket?.readyState === WebSocket.OPEN) {
          terminal.socket.send(JSON.stringify({ cols, rows, type: "resize" }));
        }
      },
    },
    usage: { snapshot: () => request("/usage") },
    windowControls: { setTitleBarOverlay: () => undefined },
  };
}
