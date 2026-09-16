import {
  addHostRegistryEntry,
  createEmptyHostRegistryDocument,
  findHostRegistryEntryByEndpoint,
  type HostRegistryDocument,
  HostRegistryDocumentSchema,
  type HttpHostEndpoint,
  type HttpsHostEndpoint,
  normalizeHttpHostUrl,
  parseContract,
} from "@omo/client-core";
import { randomUUID } from "@/lib/utils";

/**
 * Client-local Host registry storage for the browser and Electron.
 *
 * The registry document is routing/display metadata only. Bearer tokens live
 * in a separate credential vault keyed by opaque `credentialRef` values, so a
 * serialized registry never contains token material.
 *
 * Browser vault limitation: the static Web client can only persist the vault
 * in `localStorage`, where any script on the same Origin can read it. This is
 * not a secure enclave; the Electron client keeps the vault encrypted with
 * `safeStorage` instead. Documenting the limitation is the security boundary,
 * not a claim that browser storage protects tokens.
 */

export const HOST_REGISTRY_STORAGE_KEY = "omo:host-registry";
export const HOST_CREDENTIAL_VAULT_KEY = "omo:credentials";
export const LEGACY_SERVERS_KEY = "omo:servers";
export const LEGACY_URL_KEY = "omo:server-url";
export const LEGACY_TOKEN_KEY = "omo:server-token";

export const LOCAL_SERVER_ID = "local";
export const LOCAL_CREDENTIAL_REF = "vault:local";

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Vault reference for a registry entry: stable across token rotation. */
export function credentialRefForEntry(entryId: string): string {
  return `vault:${entryId}`;
}

export interface HostRegistryState {
  credentials: Record<string, string>;
  document: HostRegistryDocument;
}

/** Minimal storage surface so the adapter is testable without DOM globals. */
export interface RegistryStorageLike {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

export interface LegacyServerRecord {
  id?: string;
  name?: string;
  token?: string;
  url?: string;
}

export interface HostRegistryStorage {
  clear: () => Promise<void>;
  load: () => Promise<HostRegistryState | null>;
  save: (state: HostRegistryState) => Promise<void>;
}

export type SecureRemoteConfig =
  | { credentials: Record<string, string>; document: unknown }
  | { legacyServers: LegacyServerRecord[] };

export interface OmoSecureBridge {
  clearRemoteConfig: () => Promise<boolean>;
  loadRemoteConfig: () => Promise<SecureRemoteConfig | null>;
  saveRemoteConfig: (state: HostRegistryState) => Promise<boolean>;
}

/** Validates a serialized registry; returns null instead of throwing. */
export function parseHostRegistryDocument(
  raw: string | null | undefined
): HostRegistryDocument | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseContract(
      HostRegistryDocumentSchema,
      parsed,
      "HostRegistryDocument"
    );
  } catch {
    return null;
  }
}

/** Serializes only the registry metadata; tokens are never included. */
export function serializeHostRegistryDocument(
  document: HostRegistryDocument
): string {
  return JSON.stringify(
    parseContract(HostRegistryDocumentSchema, document, "HostRegistryDocument")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeCredentials(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const credentials: Record<string, string> = {};
  for (const [ref, token] of Object.entries(value)) {
    if (typeof token === "string" && token.length > 0) {
      credentials[ref] = token;
    }
  }
  return credentials;
}

function parseCredentialVault(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    return sanitizeCredentials(JSON.parse(raw));
  } catch {
    return {};
  }
}

function endpointFromUrl(
  value: string
): HttpHostEndpoint | HttpsHostEndpoint | null {
  try {
    const url = normalizeHttpHostUrl(value);
    return {
      transport: url.startsWith("https://") ? "https" : "http",
      url,
    };
  } catch {
    return null;
  }
}

function parseLegacyServers(raw: string | null): LegacyServerRecord[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecord).map((record) => ({
      id: typeof record.id === "string" ? record.id : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      token: typeof record.token === "string" ? record.token : undefined,
      url: typeof record.url === "string" ? record.url : undefined,
    }));
  } catch {
    return [];
  }
}

function isValidEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID_PATTERN.test(value);
}

/**
 * One-way migration of legacy `{ id, name, token, url }` server records into
 * a registry document plus credential vault. Duplicate endpoints are dropped
 * (one endpoint keeps one entry) and the reserved hosted-Web `local` record
 * becomes the synthetic local credential instead of a registry entry.
 */
export function migrateLegacyServers(
  records: readonly LegacyServerRecord[],
  legacyUrl?: string | null,
  legacyToken?: string | null
): HostRegistryState {
  const credentials: Record<string, string> = {};
  let document = createEmptyHostRegistryDocument();
  for (const record of legacyMigrationSource(records, legacyUrl, legacyToken)) {
    document = migrateLegacyRecord(record, document, credentials);
  }
  return { credentials, document };
}

function legacyMigrationSource(
  records: readonly LegacyServerRecord[],
  legacyUrl?: string | null,
  legacyToken?: string | null
): readonly LegacyServerRecord[] {
  if (records.length > 0) {
    return records;
  }
  if (!legacyUrl) {
    return [];
  }
  return [{ name: legacyUrl, token: legacyToken ?? "", url: legacyUrl }];
}

function migrateLegacyRecord(
  record: LegacyServerRecord,
  document: HostRegistryDocument,
  credentials: Record<string, string>
): HostRegistryDocument {
  if (typeof record.url !== "string" || record.url.trim() === "") {
    return document;
  }
  const endpoint = endpointFromUrl(record.url);
  if (!endpoint) {
    return document;
  }
  if (findHostRegistryEntryByEndpoint(document.entries, endpoint)) {
    return document;
  }
  if (record.id === LOCAL_SERVER_ID) {
    if (record.token) {
      credentials[LOCAL_CREDENTIAL_REF] = record.token;
    }
    return document;
  }
  const id = isValidEntryId(record.id) ? record.id : randomUUID();
  const credentialRef = record.token ? credentialRefForEntry(id) : undefined;
  const { document: next } = addHostRegistryEntry(document, {
    credentialRef,
    endpoint,
    id,
    label: record.name?.trim() || endpoint.url,
  });
  if (credentialRef && record.token) {
    credentials[credentialRef] = record.token;
  }
  return next;
}

/** Reads legacy Web config, or null when no legacy keys are present. */
export function readLegacyBrowserState(
  storage: RegistryStorageLike
): HostRegistryState | null {
  const records = parseLegacyServers(storage.getItem(LEGACY_SERVERS_KEY));
  const legacyUrl = storage.getItem(LEGACY_URL_KEY);
  if (records.length === 0 && !legacyUrl) {
    return null;
  }
  return migrateLegacyServers(
    records,
    legacyUrl,
    storage.getItem(LEGACY_TOKEN_KEY)
  );
}

/**
 * Browser storage adapter. The registry and the credential vault are separate
 * keys; legacy keys are removed on first successful read so migration is
 * one-way and idempotent.
 */
export function createBrowserHostRegistryStorage(
  storage: RegistryStorageLike
): HostRegistryStorage {
  const save = (state: HostRegistryState): Promise<void> => {
    storage.setItem(
      HOST_REGISTRY_STORAGE_KEY,
      serializeHostRegistryDocument(state.document)
    );
    if (Object.keys(state.credentials).length > 0) {
      storage.setItem(
        HOST_CREDENTIAL_VAULT_KEY,
        JSON.stringify(state.credentials)
      );
    } else {
      storage.removeItem(HOST_CREDENTIAL_VAULT_KEY);
    }
    storage.removeItem(LEGACY_SERVERS_KEY);
    storage.removeItem(LEGACY_URL_KEY);
    storage.removeItem(LEGACY_TOKEN_KEY);
    return Promise.resolve();
  };

  const load = async (): Promise<HostRegistryState | null> => {
    const raw = storage.getItem(HOST_REGISTRY_STORAGE_KEY);
    if (raw) {
      const document = parseHostRegistryDocument(raw);
      if (!document) {
        throw new Error("Stored Host registry is invalid");
      }
      return {
        credentials: parseCredentialVault(
          storage.getItem(HOST_CREDENTIAL_VAULT_KEY)
        ),
        document,
      };
    }
    const legacy = readLegacyBrowserState(storage);
    if (!legacy) {
      return null;
    }
    await save(legacy);
    return legacy;
  };

  const clear = (): Promise<void> => {
    storage.removeItem(HOST_REGISTRY_STORAGE_KEY);
    storage.removeItem(HOST_CREDENTIAL_VAULT_KEY);
    storage.removeItem(LEGACY_SERVERS_KEY);
    storage.removeItem(LEGACY_URL_KEY);
    storage.removeItem(LEGACY_TOKEN_KEY);
    return Promise.resolve();
  };

  return { clear, load, save };
}

/**
 * Electron storage adapter. Registry metadata and the credential vault travel
 * through separate IPC payloads and `safeStorage` encrypts the vault values in
 * the main process; the renderer never reads the on-disk file.
 */
export function createSecureHostRegistryStorage(
  secure: OmoSecureBridge
): HostRegistryStorage {
  const save = async (state: HostRegistryState): Promise<void> => {
    await secure.saveRemoteConfig(state);
  };

  const load = async (): Promise<HostRegistryState | null> => {
    const raw = await secure.loadRemoteConfig();
    if (!raw) {
      return null;
    }
    if ("document" in raw) {
      const document = parseHostRegistryDocument(JSON.stringify(raw.document));
      if (!document) {
        throw new Error("Stored Host registry is invalid");
      }
      return {
        credentials: sanitizeCredentials(raw.credentials),
        document,
      };
    }
    const migrated = migrateLegacyServers(raw.legacyServers);
    await save(migrated);
    return migrated;
  };

  const clear = async (): Promise<void> => {
    await secure.clearRemoteConfig();
  };

  return { clear, load, save };
}

/** In-memory adapter for tests; never a production credential store. */
export function createMemoryHostRegistryStorage(
  initial: HostRegistryState | null = null
): HostRegistryStorage {
  let state = initial;
  return {
    clear: () => {
      state = null;
      return Promise.resolve();
    },
    load: () => Promise.resolve(state),
    save: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}
