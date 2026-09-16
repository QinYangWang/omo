import {
  type AbortCommand,
  AbortCommandSchema,
  type AcceptedOperation,
  AcceptedOperationSchema,
  type AddProjectCommand,
  AddProjectCommandSchema,
  type AgentEventEnvelope,
  AgentEventEnvelopeSchema,
  HostApiContracts,
  type HostEndpoint,
  type HostHealth,
  HostHealthSchema,
  type HostId,
  HostIdSchema,
  type HostRegistryEntry,
  OkResponseSchema,
  type OpenSessionCommand,
  OpenSessionCommandSchema,
  type OpenSessionResponse,
  OpenSessionResponseSchema,
  type Project,
  ProjectListSchema,
  type PromptCommand,
  PromptCommandSchema,
  parseContract,
  SessionListSchema,
  type SessionSummary,
} from "@omo/contracts";

export interface SessionEventSubscription {
  close: () => void;
}

export interface HostClient<TSessionSnapshot = OpenSessionResponse> {
  abort: (command: AbortCommand) => Promise<void>;
  addProject: (command: AddProjectCommand) => Promise<Project>;
  health: () => Promise<HostHealth>;
  listProjects: () => Promise<Project[]>;
  listSessions: (cwd: string) => Promise<SessionSummary[]>;
  openSession: (command: OpenSessionCommand) => Promise<TSessionSnapshot>;
  prompt: (command: PromptCommand) => Promise<AcceptedOperation>;
  subscribeSession: (
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void
  ) => SessionEventSubscription;
}

export interface HttpHostClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  reconnectDelayMs?: number;
  token?: string;
}

const TRAILING_SLASH_PATTERN = /\/$/;
const SSE_LINE_ENDINGS_PATTERN = /\r\n/g;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(TRAILING_SLASH_PATTERN, "");

const eventData = (block: string): string =>
  block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

export class HostRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.status = status;
  }
}

export class HttpHostClient implements HostClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #reconnectDelayMs: number;
  readonly #token: string;

  constructor(options: HttpHostClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#token = options.token ?? "";
  }

  async health(): Promise<HostHealth> {
    return parseContract(
      HostHealthSchema,
      await this.request(HostApiContracts.health.path),
      "HostHealth"
    );
  }

  async addProject(command: AddProjectCommand): Promise<Project> {
    const body = parseContract(
      AddProjectCommandSchema,
      command,
      "AddProjectCommand"
    );
    return parseContract(
      HostApiContracts.addProject.response,
      await this.request(HostApiContracts.addProject.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "Project"
    );
  }

  async listProjects(): Promise<Project[]> {
    return parseContract(
      ProjectListSchema,
      await this.request(HostApiContracts.listProjects.path),
      "ProjectList"
    );
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const query = new URLSearchParams({ cwd });
    return parseContract(
      SessionListSchema,
      await this.request(`${HostApiContracts.listSessions.path}?${query}`),
      "SessionList"
    );
  }

  async openSession(command: OpenSessionCommand): Promise<OpenSessionResponse> {
    const body = parseContract(
      OpenSessionCommandSchema,
      command,
      "OpenSessionCommand"
    );
    return parseContract(
      OpenSessionResponseSchema,
      await this.request(HostApiContracts.openSession.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "OpenSessionResponse"
    );
  }

  async prompt(command: PromptCommand): Promise<AcceptedOperation> {
    const body = parseContract(PromptCommandSchema, command, "PromptCommand");
    return parseContract(
      AcceptedOperationSchema,
      await this.request(HostApiContracts.prompt.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "AcceptedOperation"
    );
  }

  async abort(command: AbortCommand): Promise<void> {
    const body = parseContract(AbortCommandSchema, command, "AbortCommand");
    parseContract(
      OkResponseSchema,
      await this.request(HostApiContracts.abortSession.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "OkResponse"
    );
  }

  subscribeSession(
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void
  ): SessionEventSubscription {
    if (
      !(sessionId && Number.isSafeInteger(afterSequence) && afterSequence >= 0)
    ) {
      throw new Error("Session subscription requires a valid ID and sequence");
    }
    const controller = new AbortController();
    this.runEventStream(sessionId, afterSequence, listener, controller).catch(
      () => undefined
    );
    return { close: () => controller.abort() };
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
    };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init?.headers },
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : `Host request failed (${response.status})`;
      throw new HostRequestError(response.status, message);
    }
    return value;
  }

  private async runEventStream(
    sessionId: string,
    initialSequence: number,
    listener: (event: AgentEventEnvelope) => void,
    controller: AbortController
  ): Promise<void> {
    let afterSequence = initialSequence;
    const deliver = (event: AgentEventEnvelope): void => {
      // Track the highest delivered sequence outside the per-connection read
      // so an abrupt disconnect resumes from it instead of replaying what
      // was already delivered.
      if (event.sequence > afterSequence) {
        afterSequence = event.sequence;
      }
      listener(event);
    };
    while (!controller.signal.aborted) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: reconnects are sequential.
        await this.readEventStream(
          sessionId,
          afterSequence,
          deliver,
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof HostRequestError && error.status === 401) {
          return;
        }
      }
      if (!controller.signal.aborted) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.#reconnectDelayMs)
        );
      }
    }
  }

  private async readEventStream(
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void,
    signal: AbortSignal
  ): Promise<number> {
    const query = new URLSearchParams({
      after: String(afterSequence),
      sessionId,
    });
    const response = await this.#fetch(
      `${this.#baseUrl}${HostApiContracts.sessionEvents.path}?${query}`,
      { headers: this.headers(), signal }
    );
    if (!(response.ok && response.body)) {
      throw new HostRequestError(
        response.status,
        `Host event stream failed (${response.status})`
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let cursor = afterSequence;
    while (!signal.aborted) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks are ordered.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder
        .decode(value, { stream: true })
        .replace(SSE_LINE_ENDINGS_PATTERN, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = eventData(block);
        if (data) {
          const event = parseContract(
            AgentEventEnvelopeSchema,
            JSON.parse(data),
            "AgentEventEnvelope"
          );
          if (event.sessionId !== sessionId) {
            throw new Error("Host event stream returned the wrong Session");
          }
          if (event.sequence > cursor) {
            cursor = event.sequence;
            listener(event);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return cursor;
  }
}

const TRAILING_SLASHES_PATTERN = /\/+$/;
const UNIX_ABSOLUTE_PATH_PATTERN = /^\//;
const WINDOWS_NAMED_PIPE_PATTERN = /^\\\\\.\\pipe\\[^\\/]+$/i;

/**
 * Client-local Host registry semantics shared by the CLI and Web clients.
 *
 * These helpers are deliberately pure: no persistence, no connection state
 * and no `HostRegistry` class. A client owns its own store and uses the
 * helpers to normalize endpoints, detect duplicate entries, reconcile the
 * discovered `hostId` with an entry's pinned identity and decide what a
 * browser is allowed to reach.
 */
export function isLocalHostTransport(
  transport: HostEndpoint["transport"]
): boolean {
  return transport === "unix" || transport === "pipe";
}

export function isBrowserHostTransport(
  transport: HostEndpoint["transport"]
): boolean {
  return transport === "http" || transport === "https";
}

/**
 * Normalizes an HTTP/HTTPS base URL: trims whitespace, lowercases the host,
 * drops the default port, strips the fragment, query and trailing slash and
 * rejects URLs that contain userinfo, so equivalent endpoints produce one
 * identity. Userinfo is rejected rather than silently dropped so embedded
 * credentials surface as a configuration error.
 */
export function normalizeHttpHostUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new Error(`Invalid Host URL: ${value}`, { cause: error });
  }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error(`Host URL must use HTTP or HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Host URL must not contain credentials: ${value}`);
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(TRAILING_SLASHES_PATTERN, "");
  return parsed.toString().replace(TRAILING_SLASHES_PATTERN, "");
}

/**
 * Normalizes one endpoint to the canonical form stored in a registry. URL
 * transports must match their declared scheme; local transports keep an
 * absolute Unix path or a full Windows named pipe path.
 */
export function normalizeHostEndpoint(endpoint: HostEndpoint): HostEndpoint {
  if (endpoint.transport === "http" || endpoint.transport === "https") {
    const url = normalizeHttpHostUrl(endpoint.url);
    if (!url.startsWith(`${endpoint.transport}://`)) {
      throw new Error(
        `Host endpoint transport ${endpoint.transport} does not match URL ${endpoint.url}`
      );
    }
    return { transport: endpoint.transport, url };
  }
  const path = endpoint.path.trim();
  if (endpoint.transport === "unix") {
    const normalized = path.replace(TRAILING_SLASHES_PATTERN, "");
    if (!UNIX_ABSOLUTE_PATH_PATTERN.test(normalized)) {
      throw new Error(
        `Unix Host endpoint path must be absolute: ${endpoint.path}`
      );
    }
    return { path: normalized, transport: "unix" };
  }
  if (!WINDOWS_NAMED_PIPE_PATTERN.test(path)) {
    throw new Error(
      `Windows Host named pipe endpoint must use \\\\.\\pipe\\<name>: ${endpoint.path}`
    );
  }
  return { path, transport: "pipe" };
}

/**
 * Canonical identity used for duplicate detection inside one registry. Two
 * entries are duplicates when their endpoints normalize to the same key.
 */
export function hostEndpointKey(endpoint: HostEndpoint): string {
  const normalized = normalizeHostEndpoint(endpoint);
  if (normalized.transport === "http" || normalized.transport === "https") {
    return normalized.url;
  }
  return `${normalized.transport}:${normalized.path}`;
}

/** Human-readable form of a normalized endpoint. */
export function hostEndpointLabel(endpoint: HostEndpoint): string {
  return hostEndpointKey(endpoint);
}

/**
 * Finds the entry already using this endpoint within one registry. Duplicate
 * semantics are endpoint-based; two different entries resolving to the same
 * `hostId` remain independent aliases and are intentionally not merged here.
 */
export function findHostRegistryEntryByEndpoint(
  entries: readonly HostRegistryEntry[],
  endpoint: HostEndpoint
): HostRegistryEntry | undefined {
  const key = hostEndpointKey(endpoint);
  return entries.find((entry) => hostEndpointKey(entry.endpoint) === key);
}

export type HostIdentityReconciliation =
  | { readonly hostId: HostId; readonly kind: "first-connection" }
  | { readonly hostId: HostId; readonly kind: "matching" }
  | {
      readonly expectedHostId: HostId;
      readonly kind: "mismatch";
      readonly observedHostId: HostId;
    };

/**
 * Compares the `hostId` reported by health with the entry's pinned identity.
 * `hostId` is the persistent Host installation/data-directory identity and
 * survives process restarts, so a restarted Host still matches. The caller
 * decides what to do: pin on first connection, accept a match, and surface a
 * mismatch (a different Host now owns the endpoint) instead of silently
 * rewriting the endpoint identity.
 */
export function reconcileHostIdentity(
  entry: HostRegistryEntry,
  observedHostId: string
): HostIdentityReconciliation {
  const hostId = parseContract(HostIdSchema, observedHostId, "HostId");
  if (!entry.expectedHostId) {
    return { hostId, kind: "first-connection" };
  }
  if (entry.expectedHostId === hostId) {
    return { hostId, kind: "matching" };
  }
  return {
    expectedHostId: entry.expectedHostId,
    kind: "mismatch",
    observedHostId: hostId,
  };
}

/**
 * Explicitly reassigns an entry's endpoint. The pinned identity is cleared
 * because a different endpoint must be health-verified again before it is
 * trusted; the caller persists the returned entry.
 */
export function reassignHostEndpoint(
  entry: HostRegistryEntry,
  endpoint: HostEndpoint
): HostRegistryEntry {
  return {
    ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}),
    endpoint: normalizeHostEndpoint(endpoint),
    id: entry.id,
    label: entry.label,
  };
}

/** Remote browsers can only reach HTTP/HTTPS URLs, never sockets or pipes. */
export function assertBrowserHostEndpoint(endpoint: HostEndpoint): void {
  if (isLocalHostTransport(endpoint.transport)) {
    throw new Error(
      `Browser clients cannot use ${endpoint.transport} Host endpoints; configure an HTTP or HTTPS URL`
    );
  }
}
