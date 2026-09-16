import {
  addHostRegistryEntry,
  assertBrowserHostEndpoint,
  findHostRegistryEntry,
  type HostRegistryEntry,
  type HttpHostEndpoint,
  type HttpsHostEndpoint,
  hostEndpointKey,
  normalizeHttpHostUrl,
  removeHostRegistryEntry,
  selectHostRegistryEntry,
  updateHostRegistryEntry,
} from "@omo/client-core";
import {
  credentialRefForEntry,
  type HostRegistryState,
  LOCAL_CREDENTIAL_REF,
  LOCAL_SERVER_ID,
} from "@/lib/host-registry-storage";
import { randomUUID } from "@/lib/utils";

/**
 * Pure Web registry state transitions. `servers.ts` owns the reactive store
 * and persistence around these functions; keeping the mutations pure makes
 * rotation/deletion/selection behavior testable without DOM globals.
 */

/** Normalizes a browser endpoint, rejecting local socket/pipe transports. */
export function browserEndpoint(value: string): {
  endpoint: HttpHostEndpoint | HttpsHostEndpoint;
  url: string;
} {
  const url = normalizeHttpHostUrl(value);
  const endpoint: HttpHostEndpoint | HttpsHostEndpoint = {
    transport: url.startsWith("https://") ? "https" : "http",
    url,
  };
  assertBrowserHostEndpoint(endpoint);
  return { endpoint, url };
}

export function addRemoteHost(
  state: HostRegistryState,
  input: { id?: string; name: string; token: string; url: string }
): { state: HostRegistryState; entry: HostRegistryEntry } {
  const { endpoint, url } = browserEndpoint(input.url);
  const id = input.id ?? randomUUID();
  const credentialRef = input.token ? credentialRefForEntry(id) : undefined;
  const { document, entry } = addHostRegistryEntry(state.document, {
    credentialRef,
    endpoint,
    id,
    label: input.name.trim() || url,
  });
  const credentials = { ...state.credentials };
  if (credentialRef) {
    credentials[credentialRef] = input.token;
  }
  return { entry, state: { credentials, document } };
}

export function updateRemoteHost(
  state: HostRegistryState,
  id: string,
  patch: { name: string; token: string; url: string }
): { state: HostRegistryState; entry: HostRegistryEntry } {
  const existing = findHostRegistryEntry(state.document, id);
  if (!existing) {
    throw new Error(`Unknown server: ${id}`);
  }
  const { endpoint, url } = browserEndpoint(patch.url);
  // Reassigning the endpoint clears the pinned identity; an unchanged URL
  // keeps it so a token rotation does not force a re-verification.
  const endpointChanged =
    hostEndpointKey(endpoint) !== hostEndpointKey(existing.endpoint);
  let credentialRef: string | null = existing.credentialRef ?? null;
  const credentials = { ...state.credentials };
  if (patch.token) {
    credentialRef ??= credentialRefForEntry(id);
    credentials[credentialRef] = patch.token;
  } else if (credentialRef) {
    delete credentials[credentialRef];
    credentialRef = null;
  }
  const { document, entry } = updateHostRegistryEntry(state.document, id, {
    credentialRef,
    ...(endpointChanged ? { endpoint } : {}),
    label: patch.name.trim() || url,
  });
  return { entry, state: { credentials, document } };
}

export function removeRemoteHost(
  state: HostRegistryState,
  id: string
): { state: HostRegistryState; removed?: HostRegistryEntry } {
  const existing = findHostRegistryEntry(state.document, id);
  if (!existing) {
    return { state };
  }
  const { document } = removeHostRegistryEntry(state.document, id);
  const credentials = { ...state.credentials };
  if (existing.credentialRef) {
    delete credentials[existing.credentialRef];
  }
  return { removed: existing, state: { credentials, document } };
}

/** Stores or clears the synthetic hosted-Web credential (no registry entry). */
export function setLocalCredential(
  state: HostRegistryState,
  token: string
): HostRegistryState {
  const credentials = { ...state.credentials };
  if (token) {
    credentials[LOCAL_CREDENTIAL_REF] = token;
  } else {
    delete credentials[LOCAL_CREDENTIAL_REF];
  }
  return { ...state, credentials };
}

/** `null`/`local` clears the global selection so the client defaults local. */
export function selectDefaultHost(
  state: HostRegistryState,
  id: string | null
): HostRegistryState {
  const document =
    id === null || id === LOCAL_SERVER_ID
      ? selectHostRegistryEntry(state.document, null)
      : selectHostRegistryEntry(state.document, id);
  return { ...state, document };
}

/**
 * Resolves the API target for `getServerApi`. An explicit id is strict: an
 * unknown or removed Host id throws instead of silently routing the operation
 * to another Host. Only the default path may fall back to `servers[0]`.
 */
export function resolveServerTarget<T extends { id: string }>(
  servers: readonly T[],
  explicitId: string | undefined,
  defaultId: string | undefined
): T | undefined {
  if (explicitId !== undefined) {
    const match = servers.find((server) => server.id === explicitId);
    if (!match) {
      // The caller asked for a specific entry and it is unknown or removed.
      throw new Error(`Unknown Host entry: ${explicitId}`);
    }
    return match;
  }
  return servers.find((server) => server.id === defaultId) ?? servers[0];
}
