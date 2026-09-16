import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-hooks.mjs", import.meta.url);

const {
  applyHostIdentityPin,
  createEmptyHostRegistryDocument,
  HostConnectionManager,
  hostConnectionSnapshotMap,
} = await import("../packages/client-core/dist/index.js");
const {
  createBrowserHostRegistryStorage,
  createSecureHostRegistryStorage,
  migrateLegacyServers,
  parseHostRegistryDocument,
  HOST_CREDENTIAL_VAULT_KEY,
  HOST_REGISTRY_STORAGE_KEY,
  LEGACY_SERVERS_KEY,
  LEGACY_TOKEN_KEY,
  LEGACY_URL_KEY,
  LOCAL_CREDENTIAL_REF,
} = await import("../src/lib/host-registry-storage.ts");
const {
  addRemoteHost,
  browserEndpoint,
  removeRemoteHost,
  selectDefaultHost,
  setLocalCredential,
  updateRemoteHost,
} = await import("../src/lib/host-registry-model.ts");

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const SECRET = "super-secret-bearer-token";
const HTTP_ONLY_PATTERN = /HTTP or HTTPS/;
const INVALID_PATTERN = /invalid/;

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

function emptyState() {
  return { credentials: {}, document: createEmptyHostRegistryDocument() };
}

test("legacy omo:servers migrates entries and tokens into separate keys", async () => {
  const storage = createFakeStorage({
    [LEGACY_SERVERS_KEY]: JSON.stringify([
      {
        id: "entry-1",
        name: "Team",
        token: SECRET,
        url: "HTTPS://Host.Example:443/",
      },
      {
        id: "entry-2",
        name: "Ops",
        token: "ops-token",
        url: "http://ops.example:5189",
      },
    ]),
  });
  const adapter = createBrowserHostRegistryStorage(storage);
  const state = await adapter.load();

  assert.equal(state.document.entries.length, 2);
  assert.equal(state.document.entries[0].endpoint.url, "https://host.example");
  assert.equal(state.credentials["vault:entry-1"], SECRET);
  assert.equal(state.credentials["vault:entry-2"], "ops-token");

  // Legacy keys are gone and the registry serialization excludes tokens.
  assert.equal(storage.getItem(LEGACY_SERVERS_KEY), null);
  const registryRaw = storage.getItem(HOST_REGISTRY_STORAGE_KEY);
  assert.equal(registryRaw.includes(SECRET), false);
  assert.equal(registryRaw.includes("ops-token"), false);
  const vaultRaw = storage.getItem(HOST_CREDENTIAL_VAULT_KEY);
  assert.equal(vaultRaw.includes(SECRET), true);
});

test("migration is one-way and idempotent", async () => {
  const storage = createFakeStorage({
    [LEGACY_SERVERS_KEY]: JSON.stringify([
      {
        id: "entry-1",
        name: "Team",
        token: SECRET,
        url: "https://host.example",
      },
    ]),
  });
  const adapter = createBrowserHostRegistryStorage(storage);
  const first = await adapter.load();
  const second = await adapter.load();

  assert.deepEqual(second.document, first.document);
  assert.equal(second.credentials["vault:entry-1"], SECRET);
  assert.equal(second.document.entries.length, 1);
});

test("legacy single URL/token keys migrate", async () => {
  const storage = createFakeStorage({
    [LEGACY_TOKEN_KEY]: SECRET,
    [LEGACY_URL_KEY]: "https://solo.example/",
  });
  const adapter = createBrowserHostRegistryStorage(storage);
  const state = await adapter.load();

  assert.equal(state.document.entries.length, 1);
  assert.equal(state.document.entries[0].endpoint.url, "https://solo.example");
  assert.equal(
    state.credentials[state.document.entries[0].credentialRef],
    SECRET
  );
  assert.equal(storage.getItem(LEGACY_URL_KEY), null);
  assert.equal(storage.getItem(LEGACY_TOKEN_KEY), null);
});

test("hosted-Web local record becomes a local credential, not an entry", () => {
  const state = migrateLegacyServers([
    {
      id: "local",
      name: "This server",
      token: SECRET,
      url: "https://host.example",
    },
  ]);
  assert.deepEqual(state.document.entries, []);
  assert.equal(state.credentials[LOCAL_CREDENTIAL_REF], SECRET);
});

test("browser migration skips socket and credential-bearing URLs", () => {
  const state = migrateLegacyServers([
    { url: "unix:///run/omo.sock" },
    { url: "http://user:pass@host.example" },
    { url: "https://ok.example" },
  ]);
  assert.equal(state.document.entries.length, 1);
  assert.equal(state.document.entries[0].endpoint.url, "https://ok.example");
  assert.throws(
    () => browserEndpoint("unix:///run/omo.sock"),
    HTTP_ONLY_PATTERN
  );
});

test("saving keeps tokens out of the registry document", async () => {
  const storage = createFakeStorage();
  const adapter = createBrowserHostRegistryStorage(storage);
  const { state } = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: SECRET,
    url: "https://host.example",
  });
  await adapter.save(state);

  assert.equal(
    storage.getItem(HOST_REGISTRY_STORAGE_KEY).includes(SECRET),
    false
  );
  assert.equal(
    storage.getItem(HOST_CREDENTIAL_VAULT_KEY).includes(SECRET),
    true
  );
});

test("credential rotation keeps the entry id and pinned identity", () => {
  let { state } = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: "one",
    url: "https://host.example",
  });
  state = {
    ...state,
    document: applyHostIdentityPin(state.document, {
      endpoint: state.document.entries[0].endpoint,
      entryId: "entry-1",
      expectedHostId: HOST_ID,
    }).document,
  };
  ({ state } = updateRemoteHost(state, "entry-1", {
    name: "Team",
    token: "two",
    url: "https://host.example",
  }));

  assert.equal(state.document.entries[0].id, "entry-1");
  assert.equal(state.document.entries[0].expectedHostId, HOST_ID);
  assert.equal(state.credentials["vault:entry-1"], "two");
});

test("URL reassignment clears the pinned identity", () => {
  let { state } = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: "one",
    url: "https://old.example",
  });
  state = {
    ...state,
    document: applyHostIdentityPin(state.document, {
      endpoint: state.document.entries[0].endpoint,
      entryId: "entry-1",
      expectedHostId: HOST_ID,
    }).document,
  };
  ({ state } = updateRemoteHost(state, "entry-1", {
    name: "Team",
    token: "one",
    url: "https://new.example/",
  }));

  assert.equal(state.document.entries[0].endpoint.url, "https://new.example");
  assert.equal(state.document.entries[0].expectedHostId, undefined);
});

test("clearing the token deletes the referenced credential", () => {
  let { state } = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: SECRET,
    url: "https://host.example",
  });
  ({ state } = updateRemoteHost(state, "entry-1", {
    name: "Team",
    token: "",
    url: "https://host.example",
  }));

  assert.equal(state.document.entries[0].credentialRef, undefined);
  assert.equal("vault:entry-1" in state.credentials, false);
  assert.equal(JSON.stringify(state).includes(SECRET), false);
});

test("removing an entry deletes its referenced credential", () => {
  const added = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: SECRET,
    url: "https://host.example",
  });
  const { state: addedState } = added;
  const { state, removed } = removeRemoteHost(addedState, "entry-1");
  assert.equal(removed.id, "entry-1");
  assert.equal(state.document.entries.length, 0);
  assert.equal("vault:entry-1" in state.credentials, false);
});

test("selection follows selectedEntryId and local clears it", () => {
  const added = addRemoteHost(emptyState(), {
    id: "entry-1",
    name: "Team",
    token: "",
    url: "https://host.example",
  });
  const { state: addedState } = added;
  const selected = selectDefaultHost(addedState, "entry-1");
  assert.equal(selected.document.selectedEntryId, "entry-1");

  const cleared = selectDefaultHost(selected, null);
  assert.equal("selectedEntryId" in cleared.document, false);

  const local = selectDefaultHost(selected, "local");
  assert.equal("selectedEntryId" in local.document, false);
});

test("local credential can be set and cleared", () => {
  const stored = setLocalCredential(emptyState(), SECRET);
  assert.equal(stored.credentials[LOCAL_CREDENTIAL_REF], SECRET);
  const cleared = setLocalCredential(stored, "");
  assert.equal(LOCAL_CREDENTIAL_REF in cleared.credentials, false);
});

test("mixed online/offline registry entries keep independent snapshots", async () => {
  const online = addRemoteHost(emptyState(), {
    id: "online",
    name: "Online",
    token: "",
    url: "https://online.example",
  });
  const added = addRemoteHost(online.state, {
    id: "offline",
    name: "Offline",
    token: "",
    url: "https://offline.example",
  });
  const manager = new HostConnectionManager({
    createClient: (entry) => ({
      health: () =>
        entry.id === "online"
          ? Promise.resolve({
              capabilities: [],
              hostId: HOST_ID,
              ok: true,
              protocolVersion: 1,
              version: 1,
            })
          : Promise.reject(new TypeError("fetch failed")),
    }),
    credentialResolver: { resolve: () => undefined },
    now: () => 0,
  });
  const results = await manager.probeAll(added.state.document.entries);
  const snapshots = hostConnectionSnapshotMap(results);

  assert.equal(snapshots.online.state, "online");
  assert.equal(snapshots.offline.state, "offline");
  // The healthy Host is pinned while the offline one is untouched.
  const onlineResult = results.find(
    (result) => result.snapshot.entryId === "online"
  );
  assert.equal(onlineResult.entryUpdate.expectedHostId, HOST_ID);
  const offlineResult = results.find(
    (result) => result.snapshot.entryId === "offline"
  );
  assert.equal(offlineResult.entryUpdate, undefined);
});

test("secure adapter migrates legacy config and saves the new shape", async () => {
  const saved = [];
  const secure = {
    clearRemoteConfig: () => Promise.resolve(true),
    loadRemoteConfig: () =>
      Promise.resolve({
        legacyServers: [
          {
            id: "entry-1",
            name: "Team",
            token: SECRET,
            url: "https://host.example",
          },
        ],
      }),
    saveRemoteConfig: (next) => {
      saved.push(next);
      return Promise.resolve(true);
    },
  };
  const adapter = createSecureHostRegistryStorage(secure);
  const state = await adapter.load();

  assert.equal(state.document.entries.length, 1);
  assert.equal(state.credentials["vault:entry-1"], SECRET);
  assert.equal(saved.length, 1);
  assert.equal(JSON.stringify(saved[0].document).includes(SECRET), false);
});

test("secure adapter rejects an invalid stored document", async () => {
  const secure = {
    clearRemoteConfig: () => Promise.resolve(true),
    loadRemoteConfig: () =>
      Promise.resolve({ credentials: {}, document: { schema: "nope" } }),
    saveRemoteConfig: () => Promise.resolve(true),
  };
  const adapter = createSecureHostRegistryStorage(secure);
  await assert.rejects(() => adapter.load(), INVALID_PATTERN);
});

test("malformed browser registry does not silently reset", async () => {
  const storage = createFakeStorage({
    [HOST_REGISTRY_STORAGE_KEY]: "{not-json",
  });
  const adapter = createBrowserHostRegistryStorage(storage);
  await assert.rejects(() => adapter.load(), INVALID_PATTERN);
  assert.equal(storage.getItem(HOST_REGISTRY_STORAGE_KEY), "{not-json");
});

test("parseHostRegistryDocument validates identity pins", () => {
  const parsed = parseHostRegistryDocument(
    JSON.stringify({
      entries: [
        {
          endpoint: { transport: "https", url: "https://host.example" },
          expectedHostId: HOST_ID,
          id: "entry-1",
          label: "Team",
        },
      ],
      schema: "omo.host-registry",
      version: 1,
    })
  );
  assert.equal(parsed.entries[0].expectedHostId, HOST_ID);
  assert.equal(
    parseHostRegistryDocument(JSON.stringify({ version: 99 })),
    null
  );
});
