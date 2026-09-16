import {
  type AbortCommand,
  AbortCommandSchema,
  type AcceptedOperation,
  AcceptedOperationSchema,
  type AddProjectCommand,
  AddProjectCommandSchema,
  type AgentEventEnvelope,
  AgentEventEnvelopeSchema,
  ContractValidationError,
  HOST_REGISTRY_SCHEMA,
  HOST_REGISTRY_VERSION,
  HostApiContracts,
  type HostEndpoint,
  type HostHealth,
  HostHealthSchema,
  type HostId,
  HostIdSchema,
  type HostRegistryDocument,
  type HostRegistryEntry,
  type HostRegistryEntryId,
  type HttpHostEndpoint,
  type HttpsHostEndpoint,
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

export type {
  HostEndpoint,
  HostId,
  HostRegistryDocument,
  HostRegistryEntry,
  HostRegistryEntryId,
  HttpHostEndpoint,
  HttpsHostEndpoint,
} from "@omo/contracts";
// biome-ignore lint/performance/noBarrelFile: platform clients import the registry contracts through this package.
export {
  ContractValidationError,
  HOST_REGISTRY_SCHEMA,
  HOST_REGISTRY_VERSION,
  HostRegistryDocumentSchema,
  HostRegistryEntrySchema,
  parseContract,
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

/** Machine-readable class of an HTTP Host failure, derived from status only. */
export type HostRequestErrorCode =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "server-error"
  | "unknown";

const TRAILING_SLASH_PATTERN = /\/$/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const SSE_LINE_ENDINGS_PATTERN = /\r\n/g;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const UNIX_ABSOLUTE_PATH_PATTERN = /^\//;
const WINDOWS_NAMED_PIPE_PATTERN = /^\\\\\.\\pipe\\[^\\/]+$/i;

const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(TRAILING_SLASH_PATTERN, "");

const eventData = (block: string): string =>
  block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

/**
 * Classifies an HTTP status without parsing server message text. Connection
 * code uses this so a 401 is recognized as an auth failure even when the
 * Host returns a custom error body.
 */
export function classifyHostRequestStatus(
  status: number
): HostRequestErrorCode {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status >= 400 && status < 500) {
    return "bad-request";
  }
  if (status >= 500) {
    return "server-error";
  }
  return "unknown";
}

export class HostRequestError extends Error {
  readonly code: HostRequestErrorCode;
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.status = status;
    this.code = classifyHostRequestStatus(status);
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
 * Applies a first-connection identity pin to the latest registry document.
 *
 * A probe result is captured before network I/O, so by the time a connection
 * succeeds the user may have edited the entry (URL, label, credential) or
 * added/removed/selected other entries. Applying the stale snapshot would
 * revert those edits, so this helper only writes `expectedHostId` onto the
 * entry that is still present in the latest document when:
 *
 * - the entry id still exists,
 * - its current normalized endpoint is the one that was probed, and
 * - it is not already pinned.
 *
 * Every other field and every other entry (including `selectedEntryId`) is
 * preserved. A changed or removed endpoint means the observed identity no
 * longer belongs to the current entry, so the stale pin is ignored.
 */
export function applyHostIdentityPin(
  document: HostRegistryDocument,
  pin: {
    readonly endpoint: HostEndpoint;
    readonly entryId: HostRegistryEntryId;
    readonly expectedHostId: HostId;
  }
): { applied: boolean; document: HostRegistryDocument } {
  const current = findHostRegistryEntry(document, pin.entryId);
  if (!current || current.expectedHostId) {
    return { applied: false, document };
  }
  let matches: boolean;
  try {
    matches =
      hostEndpointKey(current.endpoint) === hostEndpointKey(pin.endpoint);
  } catch {
    matches = false;
  }
  if (!matches) {
    return { applied: false, document };
  }
  return {
    applied: true,
    document: {
      ...document,
      entries: document.entries.map((candidate) =>
        candidate.id === pin.entryId
          ? { ...candidate, expectedHostId: pin.expectedHostId }
          : candidate
      ),
    },
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
export function assertBrowserHostEndpoint(
  endpoint: HostEndpoint
): asserts endpoint is HttpHostEndpoint | HttpsHostEndpoint {
  if (isLocalHostTransport(endpoint.transport)) {
    throw new Error(
      `Browser clients cannot use ${endpoint.transport} Host endpoints; configure an HTTP or HTTPS URL`
    );
  }
}

/** Creates the empty versioned registry document every client starts from. */
export function createEmptyHostRegistryDocument(): HostRegistryDocument {
  return {
    entries: [],
    schema: HOST_REGISTRY_SCHEMA,
    version: HOST_REGISTRY_VERSION,
  };
}

/** Looks up one entry by its client-local registry id. */
export function findHostRegistryEntry(
  document: HostRegistryDocument,
  id: HostRegistryEntryId
): HostRegistryEntry | undefined {
  return document.entries.find((entry) => entry.id === id);
}

/**
 * Adds one entry, rejecting duplicate normalized endpoints. Entry ids are
 * client-local and stable; a caller may inject one for deterministic tests.
 */
export function addHostRegistryEntry(
  document: HostRegistryDocument,
  input: {
    credentialRef?: CredentialRef;
    endpoint: HostEndpoint;
    id?: HostRegistryEntryId;
    label: string;
  }
): { document: HostRegistryDocument; entry: HostRegistryEntry } {
  const endpoint = normalizeHostEndpoint(input.endpoint);
  const duplicate = findHostRegistryEntryByEndpoint(document.entries, endpoint);
  if (duplicate) {
    throw new Error(
      `A Host with endpoint ${hostEndpointLabel(endpoint)} is already configured as ${duplicate.id}`
    );
  }
  const entry: HostRegistryEntry = {
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    endpoint,
    id: input.id ?? globalThis.crypto.randomUUID(),
    label: input.label,
  };
  return {
    document: { ...document, entries: [...document.entries, entry] },
    entry,
  };
}

/**
 * Removes one entry. Removing the selected entry clears `selectedEntryId`
 * instead of leaving a dangling pointer; unknown ids are a hard error.
 */
export function removeHostRegistryEntry(
  document: HostRegistryDocument,
  id: HostRegistryEntryId
): { document: HostRegistryDocument; entry: HostRegistryEntry } {
  const entry = findHostRegistryEntry(document, id);
  if (!entry) {
    throw new Error(`Unknown Host entry: ${id}`);
  }
  const next: HostRegistryDocument = {
    entries: document.entries.filter((candidate) => candidate.id !== id),
    schema: document.schema,
    version: document.version,
  };
  if (document.selectedEntryId && document.selectedEntryId !== id) {
    next.selectedEntryId = document.selectedEntryId;
  }
  return { document: next, entry };
}

/**
 * Updates one entry in place. Reassigning the endpoint clears the pinned
 * `expectedHostId` so the new endpoint is health-verified again; a label or
 * credential rotation keeps the entry id and its pinned identity.
 */
export function updateHostRegistryEntry(
  document: HostRegistryDocument,
  id: HostRegistryEntryId,
  patch: {
    credentialRef?: CredentialRef | null;
    endpoint?: HostEndpoint;
    label?: string;
  }
): { document: HostRegistryDocument; entry: HostRegistryEntry } {
  const existing = findHostRegistryEntry(document, id);
  if (!existing) {
    throw new Error(`Unknown Host entry: ${id}`);
  }
  const endpoint =
    patch.endpoint === undefined
      ? existing.endpoint
      : normalizeHostEndpoint(patch.endpoint);
  const duplicate =
    patch.endpoint === undefined
      ? undefined
      : document.entries.find(
          (candidate) =>
            candidate.id !== id &&
            hostEndpointKey(candidate.endpoint) === hostEndpointKey(endpoint)
        );
  if (duplicate) {
    throw new Error(
      `A Host with endpoint ${hostEndpointLabel(endpoint)} is already configured as ${duplicate.id}`
    );
  }
  const credentialRef =
    patch.credentialRef === undefined
      ? existing.credentialRef
      : patch.credentialRef;
  const entry: HostRegistryEntry = {
    ...(credentialRef ? { credentialRef } : {}),
    endpoint,
    ...(existing.expectedHostId && patch.endpoint === undefined
      ? { expectedHostId: existing.expectedHostId }
      : {}),
    id: existing.id,
    label: patch.label ?? existing.label,
  };
  return {
    document: {
      ...document,
      entries: document.entries.map((candidate) =>
        candidate.id === id ? entry : candidate
      ),
    },
    entry,
  };
}

/**
 * Sets the selected entry, or clears it when `id` is null. `null` means the
 * client falls back to its own default (local daemon / hosted same-origin).
 */
export function selectHostRegistryEntry(
  document: HostRegistryDocument,
  id: HostRegistryEntryId | null
): HostRegistryDocument {
  if (id === null) {
    const { selectedEntryId: _ignored, ...rest } = document;
    return rest;
  }
  if (!findHostRegistryEntry(document, id)) {
    throw new Error(`Unknown Host entry: ${id}`);
  }
  return { ...document, selectedEntryId: id };
}

/** Resolves the selected entry, or undefined when nothing valid is selected. */
export function resolveSelectedHostRegistryEntry(
  document: HostRegistryDocument
): HostRegistryEntry | undefined {
  if (!document.selectedEntryId) {
    return undefined;
  }
  return findHostRegistryEntry(document, document.selectedEntryId);
}

/**
 * Credential boundary for the client-local Host registry.
 *
 * Credential material never lives in `HostRegistryEntry`,
 * `HostRegistryDocument`, connection snapshots or logs. Entries only store an
 * opaque `credentialRef`; a `CredentialResolver` is the platform adapter that
 * turns that reference into a bearer token (Electron `safeStorage`, browser
 * storage, CLI keychain, ...). Keeping the resolver behind this small
 * interface lets `@omo/client-core` stay free of localStorage, Electron,
 * `node:http` and filesystem imports.
 */

/** Opaque pointer stored in `HostRegistryEntry.credentialRef`. */
export type CredentialRef = string;

/**
 * A resolved credential is a bearer token, or `null`/`undefined` when the
 * reference exists but has no stored secret. Callers treat an empty result as
 * an unresolved reference, never as an anonymous entry: an entry without a
 * `credentialRef` is the only anonymous case.
 */
export type ResolvedCredential = string | null | undefined;

/**
 * Resolves an entry's `credentialRef` to a bearer token. The returned value
 * is a secret and must never be written to a registry, snapshot, thrown
 * message, log or serialization.
 */
export interface CredentialResolver {
  resolve: (
    ref: CredentialRef
  ) => ResolvedCredential | Promise<ResolvedCredential>;
}

/**
 * Explicit failure for an entry that declares a `credentialRef` the resolver
 * cannot resolve. The message is intentionally generic: it must not expose
 * the reference contents or any token material.
 */
export class CredentialResolutionError extends Error {
  readonly credentialRef: CredentialRef;

  constructor(credentialRef: CredentialRef, options?: { cause?: unknown }) {
    super("Credential reference could not be resolved", options);
    this.name = "CredentialResolutionError";
    this.credentialRef = credentialRef;
  }
}

/**
 * In-memory `CredentialResolver` for tests and local fixtures only. It holds
 * a private snapshot of the supplied records so later mutation of the source
 * object cannot change what has already been handed to the connection model.
 * Production clients must persist credentials through a platform adapter
 * instead (wired by M1-003).
 */
export function createInMemoryCredentialResolver(
  records: Readonly<Record<CredentialRef, string>>
): CredentialResolver {
  const snapshot = new Map(Object.entries(records));
  return {
    resolve: (ref) => snapshot.get(ref),
  };
}

/**
 * Per-entry connection states. Every state belongs to exactly one registry
 * entry id; there is intentionally no global "fatal" or aggregate state, so
 * an auth, network or identity failure on one Host cannot mask another one.
 */
export type HostConnectionState =
  | "idle"
  | "checking"
  | "online"
  | "offline"
  | "unauthorized"
  | "credential-error"
  | "identity-mismatch";

/** Sanitized, machine-readable failure taxonomy. */
export type HostConnectionErrorCode =
  | "unreachable"
  | "unauthorized"
  | "credential-unresolved"
  | "identity-mismatch"
  | "invalid-response"
  | "unsupported-endpoint";

/**
 * Safe, serializable observation of one registry entry. It never contains a
 * bearer token or any other credential material, and it is keyed by the
 * client-local `entryId` rather than by `hostId` or endpoint.
 */
export interface HostConnectionSnapshot {
  /** Epoch milliseconds when the observation completed. */
  readonly checkedAt?: number;
  /** Best-effort normalized endpoint; raw endpoint when normalization fails. */
  readonly endpoint: HostEndpoint;
  readonly entryId: HostRegistryEntryId;
  readonly errorCode?: HostConnectionErrorCode;
  /** Sanitized message; never derived from token material. */
  readonly errorMessage?: string;
  readonly latencyMs?: number;
  /** Durable Host identity reported by a successful health call. */
  readonly observedHostId?: HostId;
  readonly state: HostConnectionState;
}

/**
 * Result of probing one registry entry. `entryUpdate` is the explicit pin
 * request: it is only produced on a first successful connection and the
 * caller is responsible for persisting it. Match, mismatch and every failure
 * leave the registry entry untouched.
 */
export interface HostProbeResult {
  readonly entryUpdate?: HostRegistryEntry;
  readonly snapshot: HostConnectionSnapshot;
}

/**
 * Platform adapter that turns a registry entry and its resolved token into a
 * `HostClient`. Browser code passes a plain HTTP client and rejects local
 * transports; Node passes a socket/pipe-backed `fetch`. Secrets only travel
 * through this factory argument, never through a snapshot.
 */
export type HostClientFactory = (
  entry: HostRegistryEntry,
  token: string | undefined
) => HostClient;

export interface HostConnectionManagerOptions {
  readonly createClient: HostClientFactory;
  readonly credentialResolver: CredentialResolver;
  readonly now?: () => number;
}

interface HostConnectionFailure {
  readonly code: HostConnectionErrorCode;
  readonly message: string;
  readonly state: HostConnectionState;
}

/** Normalizes an endpoint without throwing on malformed input. */
function safeEndpoint(endpoint: HostEndpoint): HostEndpoint {
  try {
    return normalizeHostEndpoint(endpoint);
  } catch {
    return endpoint;
  }
}

/**
 * Resolves an entry's token. A missing `credentialRef` is anonymous; a
 * present reference that throws or resolves to an empty value is an explicit
 * credential error.
 */
async function resolveEntryToken(
  entry: HostRegistryEntry,
  resolver: CredentialResolver
): Promise<string | undefined> {
  const { credentialRef } = entry;
  if (!credentialRef) {
    return undefined;
  }
  let resolved: string | null | undefined;
  try {
    resolved = await resolver.resolve(credentialRef);
  } catch (error) {
    if (error instanceof CredentialResolutionError) {
      throw error;
    }
    throw new CredentialResolutionError(credentialRef, { cause: error });
  }
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new CredentialResolutionError(credentialRef);
  }
  return resolved;
}

/** Maps an operational failure to a state and sanitized message. */
function classifyConnectionFailure(error: unknown): HostConnectionFailure {
  if (error instanceof CredentialResolutionError) {
    return {
      code: "credential-unresolved",
      message: "Credential reference could not be resolved",
      state: "credential-error",
    };
  }
  if (error instanceof HostRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: "unauthorized",
        message: "Host rejected the credential",
        state: "unauthorized",
      };
    }
    return {
      code: "unreachable",
      message: `Host request failed (HTTP ${error.status})`,
      state: "offline",
    };
  }
  if (error instanceof ContractValidationError) {
    return {
      code: "invalid-response",
      message: "Host returned an unexpected response",
      state: "offline",
    };
  }
  return {
    code: "unreachable",
    message: "Host is unreachable",
    state: "offline",
  };
}

/** Snapshot for an entry that has not been probed yet. */
export function idleHostConnectionSnapshot(
  entry: HostRegistryEntry
): HostConnectionSnapshot {
  return {
    endpoint: safeEndpoint(entry.endpoint),
    entryId: entry.id,
    state: "idle",
  };
}

/** Snapshot for an entry whose probe is in flight. */
export function checkingHostConnectionSnapshot(
  entry: HostRegistryEntry
): HostConnectionSnapshot {
  return {
    endpoint: safeEndpoint(entry.endpoint),
    entryId: entry.id,
    state: "checking",
  };
}

/**
 * Keys snapshots by registry entry id. Duplicate aliases pointing at the same
 * endpoint keep separate entries and separate observed states.
 */
export function hostConnectionSnapshotMap(
  results: readonly HostProbeResult[]
): Record<HostRegistryEntryId, HostConnectionSnapshot> {
  const map: Record<string, HostConnectionSnapshot> = {};
  for (const result of results) {
    map[result.snapshot.entryId] = result.snapshot;
  }
  return map;
}

/**
 * Shared connection/probe model for registry entries. Each call builds a
 * fresh client through the injected factory, so one entry's credentials,
 * transport or observed identity can never leak into another entry's client
 * or state. The manager is stateless: callers own persistence and the
 * selected entry, which keeps M1-002 free of an aggregate cache.
 */
export class HostConnectionManager {
  readonly #createClient: HostClientFactory;
  readonly #credentialResolver: CredentialResolver;
  readonly #now: () => number;

  constructor(options: HostConnectionManagerOptions) {
    this.#createClient = options.createClient;
    this.#credentialResolver = options.credentialResolver;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Probes one entry. Operational failures resolve to a snapshot instead of
   * rejecting, so callers always get an isolated per-entry observation.
   */
  async probe(entry: HostRegistryEntry): Promise<HostProbeResult> {
    try {
      return await this.#probeEntry(entry);
    } catch {
      return this.#failure(entry, safeEndpoint(entry.endpoint), {
        code: "unreachable",
        message: "Host probe failed unexpectedly",
        state: "offline",
      });
    }
  }

  /**
   * Probes every entry in parallel. `probe` never rejects for operational
   * failures, so a 401 on one entry, an unreachable second entry and a
   * healthy third entry all settle into independent results.
   */
  probeAll(entries: readonly HostRegistryEntry[]): Promise<HostProbeResult[]> {
    return Promise.all(entries.map((entry) => this.probe(entry)));
  }

  async #probeEntry(entry: HostRegistryEntry): Promise<HostProbeResult> {
    const endpoint = safeEndpoint(entry.endpoint);
    let token: string | undefined;
    try {
      token = await resolveEntryToken(entry, this.#credentialResolver);
    } catch (error) {
      return this.#failure(entry, endpoint, classifyConnectionFailure(error));
    }

    let client: HostClient;
    try {
      client = this.#createClient(entry, token);
    } catch {
      return this.#failure(entry, endpoint, {
        code: "unsupported-endpoint",
        message: "Host endpoint is not supported by this client",
        state: "offline",
      });
    }

    const startedAt = this.#now();
    let health: HostHealth;
    try {
      health = await client.health();
    } catch (error) {
      return this.#failure(
        entry,
        endpoint,
        classifyConnectionFailure(error),
        this.#now() - startedAt
      );
    }
    const latencyMs = this.#now() - startedAt;

    let reconciliation: HostIdentityReconciliation;
    try {
      reconciliation = reconcileHostIdentity(entry, health.hostId);
    } catch (error) {
      return this.#failure(
        entry,
        endpoint,
        classifyConnectionFailure(error),
        latencyMs
      );
    }

    if (reconciliation.kind === "mismatch") {
      return {
        snapshot: {
          checkedAt: this.#now(),
          endpoint,
          entryId: entry.id,
          errorCode: "identity-mismatch",
          errorMessage: "Host identity does not match the pinned identity",
          latencyMs,
          observedHostId: health.hostId,
          state: "identity-mismatch",
        },
      };
    }

    const snapshot: HostConnectionSnapshot = {
      checkedAt: this.#now(),
      endpoint,
      entryId: entry.id,
      latencyMs,
      observedHostId: health.hostId,
      state: "online",
    };
    if (reconciliation.kind === "first-connection") {
      return {
        entryUpdate: { ...entry, expectedHostId: reconciliation.hostId },
        snapshot,
      };
    }
    return { snapshot };
  }

  #failure(
    entry: HostRegistryEntry,
    endpoint: HostEndpoint,
    failure: HostConnectionFailure,
    latencyMs?: number
  ): HostProbeResult {
    return {
      snapshot: {
        checkedAt: this.#now(),
        endpoint,
        entryId: entry.id,
        errorCode: failure.code,
        errorMessage: failure.message,
        ...(latencyMs === undefined ? {} : { latencyMs }),
        state: failure.state,
      },
    };
  }
}
