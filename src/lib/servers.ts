import { useEffect, useSyncExternalStore } from "react";
import { createRemoteApi, normalizeBaseUrl } from "@/lib/remote-api";
import { randomUUID } from "@/lib/utils";
import { installWebPreviewApi } from "@/lib/web-preview";

export const LOCAL_SERVER_ID = "local";
const REMOTES_STORAGE_KEY = "omo:servers";
const LEGACY_URL_KEY = "omo:server-url";
const LEGACY_TOKEN_KEY = "omo:server-token";
const STATUS_POLL_MS = 15_000;
const STATUS_TIMEOUT_MS = 8_000;

export interface OmoServer {
  id: string;
  kind: "local" | "remote";
  name: string;
  removable: boolean;
  token: string;
  url: string;
}

export type ServerStatusState = "checking" | "offline" | "online";

export interface ServerStatus {
  error?: string;
  latencyMs?: number;
  state: ServerStatusState;
}

let remotes: OmoStoredRemoteServer[] = [];
let serversSnapshot: OmoServer[] = [];
let statusSnapshot: Record<string, ServerStatus> = {};
const serverListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

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

const statusMap = new Map<string, ServerStatus>();

function detectLocalServer(): OmoServer | null {
  if (window.__OMO_SERVER_URL__) {
    // Web client hosted by an omo Server: same-origin API is the local agent.
    // The access token is stored as a regular entry with the reserved id.
    const stored = remotes.find((remote) => remote.id === LOCAL_SERVER_ID);
    return {
      id: LOCAL_SERVER_ID,
      kind: "local",
      name: "This server",
      removable: false,
      token: stored?.token ?? "",
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

function buildServerList(): OmoServer[] {
  const local = detectLocalServer();
  const remoteServers: OmoServer[] = remotes
    .filter((remote) => remote.id !== LOCAL_SERVER_ID)
    .map((remote) => ({
      id: remote.id,
      kind: "remote",
      name: remote.name || remote.url,
      removable: true,
      token: remote.token,
      url: remote.url,
    }));
  return local ? [local, ...remoteServers] : remoteServers;
}

function readWebRemotes(): OmoStoredRemoteServer[] {
  try {
    const raw = localStorage.getItem(REMOTES_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is OmoStoredRemoteServer =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as OmoStoredRemoteServer).url === "string"
        );
      }
    }
  } catch (error) {
    console.error("Unable to parse stored remote servers", error);
  }
  // Migrate the legacy single-server configuration.
  const legacyUrl = normalizeBaseUrl(localStorage.getItem(LEGACY_URL_KEY) || "");
  if (legacyUrl) {
    return [
      {
        id: randomUUID(),
        name: legacyUrl,
        token: localStorage.getItem(LEGACY_TOKEN_KEY) || "",
        url: legacyUrl,
      },
    ];
  }
  return [];
}

function persistWebRemotes() {
  if (remotes.length) {
    localStorage.setItem(REMOTES_STORAGE_KEY, JSON.stringify(remotes));
  } else {
    localStorage.removeItem(REMOTES_STORAGE_KEY);
  }
  localStorage.removeItem(LEGACY_URL_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

async function persistRemotes() {
  if (window.omoSecure) {
    await window.omoSecure.saveRemoteConfig(remotes);
    localStorage.removeItem(REMOTES_STORAGE_KEY);
    localStorage.removeItem(LEGACY_URL_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    return;
  }
  persistWebRemotes();
}

export async function initializeServers() {
  if (window.omoSecure) {
    try {
      const stored = await window.omoSecure.loadRemoteConfig();
      const legacyWeb = readWebRemotes();
      // The reserved "local" id is only meaningful for server-hosted web.
      const migrateId = (remote: OmoStoredRemoteServer) =>
        remote.id === LOCAL_SERVER_ID
          ? { ...remote, id: randomUUID() }
          : remote;
      remotes = (stored.length ? stored : legacyWeb).map(migrateId);
      if (!stored.length && legacyWeb.length) {
        await window.omoSecure.saveRemoteConfig(remotes);
      }
      localStorage.removeItem(REMOTES_STORAGE_KEY);
      localStorage.removeItem(LEGACY_URL_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch (error) {
      console.error("Unable to load secure remote servers", error);
      remotes = readWebRemotes();
    }
  } else {
    remotes = readWebRemotes();
    persistWebRemotes();
  }
  notifyServers();
}

export function listServers(): OmoServer[] {
  if (!serversSnapshot.length && (remotes.length || detectLocalServer())) {
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
  if (remotes.length > 0) {
    return false;
  }
  // The localhost Vite preview remains accessible without onboarding.
  return !(location.hostname === "localhost" || location.hostname === "127.0.0.1");
}

export function getDefaultServerId(): string {
  return listServers()[0]?.id ?? LOCAL_SERVER_ID;
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

export async function addRemoteServer(input: {
  name: string;
  token: string;
  url: string;
}): Promise<OmoServer> {
  const remote: OmoStoredRemoteServer = {
    id: randomUUID(),
    name: input.name.trim(),
    token: input.token,
    url: normalizeBaseUrl(input.url),
  };
  if (!remote.url) {
    throw new Error("Server URL is required");
  }
  remotes = [...remotes, remote];
  await persistRemotes();
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
  return { ...remote, kind: "remote", removable: true };
}

export async function updateRemoteServer(
  id: string,
  patch: { name: string; token: string; url: string }
) {
  if (id === LOCAL_SERVER_ID && window.__OMO_SERVER_URL__) {
    await setLocalServerToken(patch.token);
    return;
  }
  remotes = remotes.map((remote) =>
    remote.id === id
      ? {
          ...remote,
          name: patch.name.trim(),
          token: patch.token,
          url: normalizeBaseUrl(patch.url),
        }
      : remote
  );
  await persistRemotes();
  apiCache.delete(id);
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
}

/** Stores the access token for the server hosting this web client. */
export async function setLocalServerToken(token: string) {
  const url = normalizeBaseUrl(window.__OMO_SERVER_URL__ || "");
  if (!url) {
    throw new Error("No hosting server detected");
  }
  const entry: OmoStoredRemoteServer = {
    id: LOCAL_SERVER_ID,
    name: "This server",
    token,
    url,
  };
  remotes = remotes.some((remote) => remote.id === LOCAL_SERVER_ID)
    ? remotes.map((remote) => (remote.id === LOCAL_SERVER_ID ? entry : remote))
    : [...remotes, entry];
  apiCache.delete(LOCAL_SERVER_ID);
  await persistRemotes();
  notifyServers();
  refreshServerStatuses().catch(() => undefined);
}

export async function removeRemoteServer(id: string) {
  remotes = remotes.filter((remote) => remote.id !== id);
  apiCache.delete(id);
  statusMap.delete(id);
  await persistRemotes();
  notifyServers();
  notifyStatuses();
}

const apiCache = new Map<string, { api: omoApi; key: string }>();

export function getServerApi(serverId?: string): omoApi {
  const servers = listServers();
  const server =
    servers.find((item) => item.id === serverId) ?? servers[0] ?? undefined;
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

async function checkServer(server: OmoServer): Promise<ServerStatus> {
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

export async function refreshServerStatuses() {
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
  await Promise.all(
    servers.map(async (server) => {
      statusMap.set(server.id, { state: "checking" });
      notifyStatuses();
      statusMap.set(server.id, await checkServer(server));
      notifyStatuses();
    })
  );
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
