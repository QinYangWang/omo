import { randomUUID } from "@/lib/utils";

const trailingSlash = /\/$/;
const httpScheme = /^http:/;
const httpsScheme = /^https:/;
const sseLineEndings = /\r\n/g;

type EventCallback = (data: OmoPiEventEnvelope) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const terminalListeners = new Set<(data: string) => void>();
  const streams = new Map<string, AbortController>();
  let terminalId = "";
  let terminalSocket: WebSocket | undefined;
  let terminalOffset = 0;
  let terminalRetry = 1000;
  let terminalReconnect: ReturnType<typeof setTimeout> | undefined;

  const connectEvents = (sessionId: string) => {
    if (streams.has(sessionId)) {
      return;
    }
    const controller = new AbortController();
    streams.set(sessionId, controller);
    let retry = 1000;

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
        const after = Number(localStorage.getItem(sequenceKey) || 0);
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

  const reconnectTerminal = async () => {
    if (!terminalId) {
      return;
    }
    try {
      const result = await post<{ ticket: string }>(
        `/terminals/${encodeURIComponent(terminalId)}/ticket`,
        {}
      );
      connectTerminal(result.ticket);
    } catch (error) {
      console.warn("Remote terminal reconnecting", error);
      terminalReconnect = setTimeout(
        () => {
          reconnectTerminal();
        },
        terminalRetry + Math.random() * terminalRetry * 0.2
      );
    }
  };

  const scheduleTerminalReconnect = () => {
    terminalReconnect = setTimeout(
      () => {
        reconnectTerminal();
      },
      terminalRetry + Math.random() * terminalRetry * 0.2
    );
    terminalRetry = Math.min(30_000, terminalRetry * 2);
  };

  const handleTerminalMessage = (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.type !== "string") {
      return;
    }
    if (payload.type === "reset" && typeof payload.offset === "number") {
      terminalOffset = payload.offset;
      for (const listener of terminalListeners) {
        listener("\u001bc");
      }
      return;
    }
    if (
      payload.type !== "output" ||
      typeof payload.nextOffset !== "number" ||
      typeof payload.offset !== "number"
    ) {
      return;
    }
    if (payload.nextOffset <= terminalOffset) {
      return;
    }
    const skip = Math.max(0, terminalOffset - payload.offset);
    const data = String(payload.data).slice(skip);
    terminalOffset = payload.nextOffset;
    for (const listener of terminalListeners) {
      listener(data);
    }
  };

  const connectTerminal = (ticket: string) => {
    if (!terminalId) {
      return;
    }
    const wsBase = base.replace(httpScheme, "ws:").replace(httpsScheme, "wss:");
    const socket = new WebSocket(
      `${wsBase}/api/v1/terminals/${encodeURIComponent(terminalId)}/stream?${query({ after: String(terminalOffset), ticket })}`
    );
    terminalSocket = socket;
    socket.onopen = () => {
      terminalRetry = 1000;
    };
    socket.onmessage = (event) => {
      handleTerminalMessage(JSON.parse(String(event.data)) as unknown);
    };
    socket.onclose = () => {
      if (!terminalId || terminalSocket !== socket) {
        return;
      }
      scheduleTerminalReconnect();
    };
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
      diff: async (cwd, file) =>
        (await request<{ output: string }>(`/git/diff?${query({ cwd, file })}`))
          .output,
      status: async (cwd) =>
        (await request<{ output: string }>(`/git/status?${query({ cwd })}`))
          .output,
    },
    pi: {
      abort: async (sessionId) => {
        await post("/pi/abort", { sessionId });
      },
      commands: (sessionId, cwd, sessionPath) =>
        post("/pi/commands", { cwd, sessionId, sessionPath }),
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
          model?: { id: string; name: string; provider: string } | null;
          thinkingLevel?: string;
        }>("/pi/open", {
          cwd,
          sessionId,
          sessionPath,
        });
        const sequenceKey = `omo:event-sequence:${base}:${sessionId}`;
        if (
          typeof result.eventSequence === "number" &&
          !localStorage.getItem(sequenceKey)
        ) {
          localStorage.setItem(sequenceKey, String(result.eventSequence));
        }
        connectEvents(sessionId);
        return result;
      },
      prompt: async (sessionId, message, cwd, sessionPath, images) => {
        await post("/pi/prompt", {
          cwd,
          images,
          message,
          requestId: randomUUID(),
          sessionId,
          sessionPath,
        });
      },
      setModel: async (sessionId, provider, modelId) => {
        await post("/pi/model", { modelId, provider, sessionId });
      },
      setThinking: async (sessionId, level) => {
        await post("/pi/thinking", { level, sessionId });
      },
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
      import: async (sourcePath, cwd) =>
        (await post<{ path: string }>("/sessions/import", { cwd, sourcePath }))
          .path,
      list: (cwd) => request(`/sessions?${query({ cwd })}`),
    },
    term: {
      create: async (cwd) => {
        if (terminalId && terminalSocket?.readyState !== WebSocket.CLOSED) {
          return;
        }
        if (terminalReconnect) {
          clearTimeout(terminalReconnect);
        }
        const result = await post<{
          terminalId: string;
          offset: number;
          ticket: string;
        }>("/terminals", { cwd });
        const { terminalId: nextTerminalId, offset, ticket } = result;
        terminalId = nextTerminalId;
        terminalOffset = offset;
        connectTerminal(ticket);
      },
      input: (data) => {
        if (terminalSocket?.readyState === WebSocket.OPEN) {
          terminalSocket.send(JSON.stringify({ data, type: "input" }));
        }
      },
      onData: (callback) => {
        terminalListeners.add(callback);
        return () => terminalListeners.delete(callback);
      },
    },
    usage: { snapshot: () => request("/usage") },
    skills: { list: () => request("/skills") },
    models: {
      list: () => request("/models"),
      setEnabled: (enabled) => post("/models", { enabled }),
    },
    packages: {
      install: (source) => post("/packages/install", { source }),
      list: () => request("/packages"),
      remove: (source) => post("/packages/remove", { source }),
    },
    windowControls: { setTitleBarOverlay: () => undefined },
  };
}
