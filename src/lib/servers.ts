import {
  applyHostIdentityPin,
  assertBrowserHostEndpoint,
  createEmptyHostRegistryDocument,
  type HostConnectionErrorCode,
  HostConnectionManager,
  type HostConnectionSnapshot,
  type HostConnectionState,
  type HostEndpoint,
  type HostRegistryDocument,
  type HostRegistryEntry,
  HttpHostClient,
  hostEndpointLabel,
  resolveSelectedHostRegistryEntry,
} from "@omo/client-core";
import { useEffect, useSyncExternalStore } from "react";
import {
  addRemoteHost,
  removeRemoteHost,
  resolveServerTarget,
  selectDefaultHost,
  setLocalCredential,
  updateRemoteHost,
} from "@/lib/host-registry-model";
import {
  createBrowserHostRegistryStorage,
  createSecureHostRegistryStorage,
  type HostRegistryState,
  type HostRegistryStorage,
  LEGACY_SERVERS_KEY,
  LEGACY_TOKEN_KEY,
  LEGACY_URL_KEY,
  LOCAL_CREDENTIAL_REF,
  LOCAL_SERVER_ID,
  readLegacyBrowserState,
} from "@/lib/host-registry-storage";
import { createRemoteApi, normalizeBaseUrl } from "@/lib/remote-api";
import { installWebPreviewApi } from "@/lib/web-preview";

const STATUS_POLL_MS = 15_000;
const STATUS_TIMEOUT_MS = 8000;

export interface OmoServer {
  id: string;
  kind: "local" | "remote";
  name: string;
  removable: boolean;
  token: string;
  url: string;
}

export type ServerStatusState =
  | "checking"
  | "offline"
  | "online"
  | "unauthorized"
  | "credential-error"
  | "identity-mismatch";

export interface ServerStatus {
  error?: string;
  /** Machine-readable code preserved for callers; never contains a token. */
  errorCode?: HostConnectionErrorCode;
  latencyMs?: number;
  state: ServerStatusState;
}

let storage: HostRegistryStorage | null = null;
let registry: HostRegistryDocument = createEmptyHostRegistryDocument();
let credentials: Record<string, string> = {};
let serversSnapshot: OmoServer[] = [];
let statusSnapshot: Record<string, ServerStatus> = {};
const serverListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();
const statusMap = new Map<string, ServerStatus>();
let refreshPromise: Promise<void> | null = null;

function notifyServers() {
  serversSnapshot = buildServerList();
  for (const listener of serverListeners) {
    listener();
  }
}

function notifyStatuses() {
  statusSnapshot = Object.fromEntries(statusMap);
  for (const listener of statusListeners) {
    listener();
  }
}

function createDefaultStorage(): HostRegistryStorage {
  if (window.omoSecure) {
    return createSecureHostRegistryStorage(window.omoSecure);
  }
  return createBrowserHostRegistryStorage(localStorage);
}

function getStorage(): HostRegistryStorage {
  storage ??= createDefaultStorage();
  return storage;
}

function clearLegacyBrowserKeys() {
  localStorage.removeItem(LEGACY_SERVERS_KEY);
  localStorage.removeItem(LEGACY_URL_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function applyState(state: HostRegistryState | null) {
  registry = state?.document ?? createEmptyHostRegistryDocument();
  credentials = state?.credentials ?? {};
  statusMap.clear();
}

function applyModelState(state: HostRegistryState) {
  const { credentials: nextCredentials, document } = state;
  registry = document;
  credentials = nextCredentials;
}

function detectLocalServer(): OmoServer | null {
  if (window.__OMO_SERVER_URL__) {
    // Web client hosted by an omo Server: same-origin API is the local agent.
    return {
      id: LOCAL_SERVER_ID,
      kind: "local",
      name: "This server",
      removable: false,
      token: credentials[LOCAL_CREDENTIAL_REF] ?? "",
      url: normalizeBaseUrl(window.__OMO_SERVER_URL__),
    };
  }
  if (window.omo) {
    // Electron in-process agent, or the browser preview stub.
    return {
      id: LOCAL_SERVER_ID,
      kind: "local",
      name: window.omoSecure ? "This machine" : "Preview",
      removable: false,
      token: "",
      url: "",
    };
  }
  return null;
}

function tokenForEntry(entry: HostRegistryEntry): string {
  return entry.credentialRef ? (credentials[entry.credentialRef] ?? "") : "";
}

function endpointUrl(endpoint: HostEndpoint): string {
  return endpoint.transport === "http" || endpoint.transport === "https"
    ? endpoint.url
    : hostEndpointLabel(endpoint);
}

function buildServerList(): OmoServer[] {
  const local = detectLocalServer();
  const remoteServers: OmoServer[] = registry.entries.map((entry) => ({
    id: entry.id,
    kind: "remote",
    name: entry.label || hostEndpointLabel(entry.endpoint),
    removable: true,
    token: tokenForEntry(entry),
    url: endpointUrl(entry.endpoint),
  }));
  return local ? [local, ...remoteServers] : remoteServers;
}

async function persist() {
  await getStorage().save({ credentials, document: registry });
}

export async function initializeServers() {
  storage = createDefaultStorage();
  try {
    let state = await storage.load();
    if (!state && window.omoSecure) {
      // First Electron run: migrate legacy browser-local config to safeStorage.
      const legacy = readLegacyBrowserState(localStorage);
      if (legacy) {
        await storage.save(legacy);
        state = legacy;
      }
    }
    if (window.omoSecure) {
      clearLegacyBrowserKeys();
    }
    applyState(state);
  } catch (error) {
    console.error("Unable to load Host registry", error);
    applyState(null);
  }
  notifyServers();
}

export function listServers(): OmoServer[] {
  if (
    !serversSnapshot.length &&
    (registry.entries.length || detectLocalServer())
  ) {
    serversSnapshot = buildServerList();
  }
  return serversSnapshot;
}

export function subscribeServers(listener: () => void) {
  serverListeners.add(listener);
  return () => {
    serverListeners.delete(listener);
  };
}

export function useServers(): OmoServer[] {
  return useSyncExternalStore(subscribeServers, listServers);
}

export function getServer(serverId: string | undefined): OmoServer | undefined {
  const servers = listServers();
  return servers.find((server) => server.id === serverId) ?? undefined;
}

/**
 * Web clients must sign in (hosted web) or add a remote server (static web)
 * before entering the app. Electron always has the in-process agent.
 */
export async function needsOnboarding(): Promise<boolean> {
  if (window.omoSecure) {
    return false;
  }
  const local = detectLocalServer();
  if (window.__OMO_SERVER_URL__ && local) {
    try {
      await testServerConnection(local.url, local.token);
      return false;
    } catch {
      return true;
    }
  }
  if (registry.entries.length > 0) {
    return false;
  }
  // The localhost Vite preview remains accessible without onboarding.
  return !(
    location.hostname === "localhost" || location.hostname === "127.0.0.1"
  );
}

/**
 * Default/global surface selection. A valid `selectedEntryId` wins; otherwise
 * the client falls back to its first server (local when present). Invalid
 * selections are ignored without deleting the entry.
 */
export function getDefaultServerId(): string {
  const selected = resolveSelectedHostRegistryEntry(registry);
  if (selected) {
    return selected.id;
  }
  return listServers()[0]?.id ?? LOCAL_SERVER_ID;
}

/** Persists the default Host selection; `null`/`local` selects the local one. */
export async function setSelectedServerId(id: string | null): Promise<void> {
  applyModelState(selectDefaultHost({ credentials, document: registry }, id));
  await persist();
  notifyServers();
}

/** AbortSignal.timeout is missing on Safari < 16.4 and older Chromium. */
function timeoutSignal(ms: number): AbortSignal {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Adds a remote Host and its vault credential. */
export async function addRemoteServer(input: {
  name: string;
  token: string;
  url: string;
}): Promise<OmoServer> {
  const { state, entry } = addRemoteHost(
    { credentials, document: registry },
    input
  );
  applyModelState(state);
  await persist();
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
  return {
    id: entry.id,
    kind: "remote",
    name: entry.label,
    removable: true,
    token: input.token,
    url: endpointUrl(entry.endpoint),
  };
}

export async function updateRemoteServer(
  id: string,
  patch: { name: string; token: string; url: string }
) {
  if (id === LOCAL_SERVER_ID && window.__OMO_SERVER_URL__) {
    await setLocalServerToken(patch.token);
    return;
  }
  const { state } = updateRemoteHost(
    { credentials, document: registry },
    id,
    patch
  );
  applyModelState(state);
  await persist();
  apiCache.delete(id);
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
}

/** Stores the access token for the server hosting this web client. */
export async function setLocalServerToken(token: string) {
  const base = normalizeBaseUrl(window.__OMO_SERVER_URL__ || "");
  if (!base) {
    throw new Error("No hosting server detected");
  }
  applyModelState(
    setLocalCredential({ credentials, document: registry }, token)
  );
  apiCache.delete(LOCAL_SERVER_ID);
  await persist();
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
}

export async function removeRemoteServer(id: string) {
  const { state, removed } = removeRemoteHost(
    { credentials, document: registry },
    id
  );
  if (!removed) {
    return;
  }
  applyModelState(state);
  apiCache.delete(id);
  statusMap.delete(id);
  await persist();
  notifyServers();
  notifyStatuses();
}

const apiCache = new Map<string, { api: omoApi; key: string }>();

export function getServerApi(serverId?: string): omoApi {
  const servers = listServers();
  // An explicit id is strict: an unknown/removed Host throws instead of
  // routing the operation to a different Host. Only the default path may
  // fall back to the first configured server (or the preview API).
  const server = resolveServerTarget(servers, serverId, getDefaultServerId());
  if (!server) {
    // Pure static web without any configured server: fall back to preview data.
    installWebPreviewApi();
    return window.omo;
  }
  if (server.kind === "local" && !server.url) {
    return window.omo;
  }
  const key = `${server.url}\n${server.token}`;
  const cached = apiCache.get(server.id);
  if (cached?.key === key) {
    return cached.api;
  }
  const api = createRemoteApi(server.url, server.token);
  apiCache.set(server.id, { api, key });
  return api;
}

export async function testServerConnection(
  url: string,
  token: string
): Promise<{ latencyMs: number }> {
  const base = normalizeBaseUrl(url);
  if (!base) {
    throw new Error("Server URL is required");
  }
  const started = performance.now();
  const response = await fetch(`${base}/api/v1/cwd`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: timeoutSignal(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return { latencyMs: Math.round(performance.now() - started) };
}

function mapConnectionState(state: HostConnectionState): ServerStatusState {
  switch (state) {
    case "unauthorized":
      return "unauthorized";
    case "credential-error":
      return "credential-error";
    case "identity-mismatch":
      return "identity-mismatch";
    case "online":
      return "online";
    case "offline":
      return "offline";
    default:
      return "checking";
  }
}

function snapshotToStatus(snapshot: HostConnectionSnapshot): ServerStatus {
  const status: ServerStatus = { state: mapConnectionState(snapshot.state) };
  if (typeof snapshot.latencyMs === "number") {
    status.latencyMs = snapshot.latencyMs;
  }
  if (snapshot.errorCode) {
    status.errorCode = snapshot.errorCode;
  }
  if (snapshot.errorMessage) {
    status.error = snapshot.errorMessage;
  }
  return status;
}

async function checkLocalServer(server: OmoServer): Promise<ServerStatus> {
  if (server.kind === "local" && !server.url) {
    return { state: "online" };
  }
  try {
    const { latencyMs } = await testServerConnection(server.url, server.token);
    return { latencyMs, state: "online" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      state: "offline",
    };
  }
}

/** Builds the shared per-entry connection manager for the browser client. */
function createConnectionManager(): HostConnectionManager {
  return new HostConnectionManager({
    createClient: (entry, token) => {
      assertBrowserHostEndpoint(entry.endpoint);
      return new HttpHostClient({ baseUrl: entry.endpoint.url, token });
    },
    // A present reference missing from the vault resolves to undefined, which
    // the manager reports as credential-error rather than pretending to be
    // anonymous.
    credentialResolver: { resolve: (ref) => credentials[ref] },
  });
}

async function runRefresh() {
  const servers = listServers();
  for (const server of servers) {
    if (!statusMap.has(server.id)) {
      statusMap.set(server.id, { state: "checking" });
    }
  }
  for (const id of [...statusMap.keys()]) {
    if (!servers.some((server) => server.id === id)) {
      statusMap.delete(id);
    }
  }
  notifyStatuses();

  const localServers = servers.filter((server) => server.kind === "local");
  for (const server of localServers) {
    statusMap.set(server.id, { state: "checking" });
  }
  notifyStatuses();

  const manager = createConnectionManager();
  const results = await manager.probeAll(registry.entries);
  let pinned = false;
  for (const result of results) {
    statusMap.set(result.snapshot.entryId, snapshotToStatus(result.snapshot));
    const update = result.entryUpdate;
    if (update?.expectedHostId) {
      // Apply the pin against the latest registry, not the pre-probe entry:
      // a concurrent URL/label/credential edit or selection must survive.
      const next = applyHostIdentityPin(registry, {
        endpoint: result.snapshot.endpoint,
        entryId: update.id,
        expectedHostId: update.expectedHostId,
      });
      if (next.applied) {
        registry = next.document;
        pinned = true;
      }
    }
  }
  notifyStatuses();

  if (pinned) {
    try {
      await persist();
    } catch (error) {
      // Identity pinning is best effort; a failed write must not break status.
      console.error("Unable to persist Host identity", error);
    }
  }

  await Promise.all(
    localServers.map(async (server) => {
      statusMap.set(server.id, await checkLocalServer(server));
      notifyStatuses();
    })
  );
}

export function refreshServerStatuses(): Promise<void> {
  refreshPromise ??= runRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function subscribeServerStatuses(listener: () => void) {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function getServerStatuses(): Record<string, ServerStatus> {
  return statusSnapshot;
}

export function useServerStatuses(): Record<string, ServerStatus> {
  const statuses = useSyncExternalStore(
    subscribeServerStatuses,
    getServerStatuses
  );
  useEffect(() => {
    refreshServerStatuses().catch(() => undefined);
    const timer = setInterval(() => {
      refreshServerStatuses().catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return statuses;
}
