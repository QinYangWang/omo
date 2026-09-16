import assert from "node:assert/strict";
import test from "node:test";
import { ContractValidationError } from "@omo/contracts";
import {
  CredentialResolutionError,
  checkingHostConnectionSnapshot,
  createInMemoryCredentialResolver,
  HostConnectionManager,
  HostRequestError,
  hostConnectionSnapshotMap,
  idleHostConnectionSnapshot,
} from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const OTHER_HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f3";
const SECRET = "super-secret-bearer-token";

const health = (hostId = HOST_ID) => ({
  capabilities: ["pi", "events"],
  hostId,
  ok: true,
  protocolVersion: 1,
  version: 1,
});

const httpEntry = (id, overrides = {}) => ({
  endpoint: { transport: "http", url: `http://${id}.example:5189` },
  id,
  label: id,
  ...overrides,
});

/** Builds a manager whose factory records the token it receives per entry. */
function createManager({ healthFor, resolver, now = () => 0 } = {}) {
  const tokens = new Map();
  const createdFor = [];
  const createClient = (entry, token) => {
    createdFor.push(entry.id);
    tokens.set(entry.id, token);
    return {
      health: () => healthFor(entry),
    };
  };
  const manager = new HostConnectionManager({
    createClient,
    credentialResolver: resolver ?? createInMemoryCredentialResolver({}),
    now,
  });
  return { createdFor, manager, tokens };
}

test("anonymous entries probe without a token and pin on first connection", async () => {
  let clock = 0;
  const { manager, tokens, createdFor } = createManager({
    healthFor: () => {
      clock += 7;
      return Promise.resolve(health());
    },
    now: () => clock,
  });
  const entry = httpEntry("entry-a");

  const result = await manager.probe(entry);

  assert.deepEqual(createdFor, ["entry-a"]);
  assert.equal(tokens.get("entry-a"), undefined);
  assert.equal(result.snapshot.state, "online");
  assert.equal(result.snapshot.observedHostId, HOST_ID);
  assert.equal(result.snapshot.entryId, "entry-a");
  assert.equal(result.snapshot.latencyMs, 7);
  assert.equal(result.snapshot.checkedAt, 7);
  assert.deepEqual(result.snapshot.endpoint, {
    transport: "http",
    url: "http://entry-a.example:5189",
  });
  // First connection asks the caller to persist the pinned identity.
  assert.equal(result.entryUpdate.expectedHostId, HOST_ID);
  // The input entry is never mutated.
  assert.equal("expectedHostId" in entry, false);
});

test("credential references resolve to a token only inside the factory", async () => {
  const { manager, tokens } = createManager({
    healthFor: () => Promise.resolve(health()),
    resolver: createInMemoryCredentialResolver({ "ref-a": SECRET }),
  });
  const entry = httpEntry("entry-a", { credentialRef: "ref-a" });

  const result = await manager.probe(entry);

  assert.equal(tokens.get("entry-a"), SECRET);
  assert.equal(result.snapshot.state, "online");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result.entryUpdate).includes(SECRET), false);
});

test("a present but unresolved reference is an explicit credential error", async () => {
  const { manager, createdFor, tokens } = createManager({
    healthFor: () => Promise.resolve(health()),
    resolver: createInMemoryCredentialResolver({}),
  });
  const entry = httpEntry("entry-a", { credentialRef: "missing" });

  const result = await manager.probe(entry);

  assert.deepEqual(createdFor, []);
  assert.equal(tokens.size, 0);
  assert.equal(result.snapshot.state, "credential-error");
  assert.equal(result.snapshot.errorCode, "credential-unresolved");
  assert.equal(result.snapshot.errorMessage.includes("missing"), false);
  assert.equal(result.entryUpdate, undefined);
});

test("a throwing resolver is also an explicit credential error", async () => {
  const resolver = {
    resolve: () => {
      throw new Error(`backend failed for ${SECRET}`);
    },
  };
  const { manager, createdFor } = createManager({
    healthFor: () => Promise.resolve(health()),
    resolver,
  });

  const result = await manager.probe(
    httpEntry("entry-a", { credentialRef: "ref-a" })
  );

  assert.deepEqual(createdFor, []);
  assert.equal(result.snapshot.state, "credential-error");
  assert.equal(result.snapshot.errorCode, "credential-unresolved");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("a 401 isolates as unauthorized without exposing server text", async () => {
  const { manager } = createManager({
    healthFor: () =>
      Promise.reject(new HostRequestError(401, `Denied: ${SECRET}`)),
    resolver: createInMemoryCredentialResolver({ "ref-a": SECRET }),
  });

  const result = await manager.probe(
    httpEntry("entry-a", { credentialRef: "ref-a" })
  );

  assert.equal(result.snapshot.state, "unauthorized");
  assert.equal(result.snapshot.errorCode, "unauthorized");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("an unreachable Host isolates as offline", async () => {
  const { manager } = createManager({
    healthFor: () => Promise.reject(new TypeError("fetch failed")),
  });

  const result = await manager.probe(httpEntry("entry-a"));

  assert.equal(result.snapshot.state, "offline");
  assert.equal(result.snapshot.errorCode, "unreachable");
  assert.equal(result.snapshot.errorMessage, "Host is unreachable");
});

test("an invalid health payload isolates as an unexpected response", async () => {
  const { manager } = createManager({
    healthFor: () =>
      Promise.reject(new ContractValidationError("HostHealth", ["bad"])),
  });

  const result = await manager.probe(httpEntry("entry-a"));

  assert.equal(result.snapshot.state, "offline");
  assert.equal(result.snapshot.errorCode, "invalid-response");
});

test("identity mismatch is isolated and never mutates the entry", async () => {
  const { manager } = createManager({
    healthFor: () => Promise.resolve(health(OTHER_HOST_ID)),
  });
  const entry = httpEntry("entry-a", { expectedHostId: HOST_ID });
  const before = structuredClone(entry);

  const result = await manager.probe(entry);

  assert.equal(result.snapshot.state, "identity-mismatch");
  assert.equal(result.snapshot.errorCode, "identity-mismatch");
  assert.equal(result.snapshot.observedHostId, OTHER_HOST_ID);
  assert.equal(result.entryUpdate, undefined);
  assert.deepEqual(entry, before);
});

test("a match succeeds and a restarted Host with the same identity matches", async () => {
  const { manager } = createManager({
    healthFor: () => Promise.resolve(health(HOST_ID)),
  });
  // Simulates a Host process restart: hostId is persisted, so it still matches.
  const entry = httpEntry("entry-a", { expectedHostId: HOST_ID });
  const before = structuredClone(entry);

  const result = await manager.probe(entry);

  assert.equal(result.snapshot.state, "online");
  assert.equal(result.entryUpdate, undefined);
  assert.deepEqual(entry, before);
});

test("parallel probing settles every entry independently", async () => {
  const { manager, createdFor } = createManager({
    healthFor: (entry) => {
      if (entry.id === "entry-a") {
        return Promise.reject(new HostRequestError(401, "Denied"));
      }
      if (entry.id === "entry-b") {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(health());
    },
    resolver: createInMemoryCredentialResolver({ "ref-a": SECRET }),
  });
  const entries = [
    httpEntry("entry-a", { credentialRef: "ref-a" }),
    httpEntry("entry-b"),
    httpEntry("entry-c"),
  ];

  const results = await manager.probeAll(entries);
  const snapshots = hostConnectionSnapshotMap(results);

  assert.equal(results.length, 3);
  assert.deepEqual(createdFor.sort(), ["entry-a", "entry-b", "entry-c"]);
  assert.equal(snapshots["entry-a"].state, "unauthorized");
  assert.equal(snapshots["entry-b"].state, "offline");
  assert.equal(snapshots["entry-c"].state, "online");
  assert.equal(snapshots["entry-c"].observedHostId, HOST_ID);
});

test("duplicate aliases keep separate clients and separate states", async () => {
  const { manager, createdFor } = createManager({
    healthFor: (entry) =>
      entry.id === "alias-a"
        ? Promise.resolve(health())
        : Promise.reject(new HostRequestError(401, "Denied")),
  });
  const endpoint = { transport: "https", url: "https://shared.example" };
  const entries = [
    { endpoint, id: "alias-a", label: "Primary" },
    { endpoint, id: "alias-b", label: "Secondary" },
  ];

  const results = await manager.probeAll(entries);
  const snapshots = hostConnectionSnapshotMap(results);

  assert.equal(createdFor.length, 2);
  assert.equal(new Set(createdFor).size, 2);
  assert.equal(snapshots["alias-a"].state, "online");
  assert.equal(snapshots["alias-b"].state, "unauthorized");
});

test("snapshots and updates never serialize credential material", async () => {
  const { manager } = createManager({
    healthFor: () => Promise.resolve(health()),
    resolver: createInMemoryCredentialResolver({ "ref-a": SECRET }),
  });
  const entry = httpEntry("entry-a", { credentialRef: "ref-a" });

  const result = await manager.probe(entry);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("Bearer"), false);
});

test("in-memory resolver is a private snapshot of its source records", async () => {
  const source = { "ref-a": SECRET };
  const resolver = createInMemoryCredentialResolver(source);
  source["ref-a"] = "changed";
  source["ref-b"] = "added";

  assert.equal(await resolver.resolve("ref-a"), SECRET);
  assert.equal(await resolver.resolve("ref-b"), undefined);
});

test("idle and checking snapshots are keyed by entry id with no token data", () => {
  const entry = httpEntry("entry-a", { credentialRef: "ref-a" });
  const idle = idleHostConnectionSnapshot(entry);
  const checking = checkingHostConnectionSnapshot(entry);

  assert.equal(idle.entryId, "entry-a");
  assert.equal(idle.state, "idle");
  assert.equal(checking.entryId, "entry-a");
  assert.equal(checking.state, "checking");
  assert.equal(JSON.stringify(idle).includes(SECRET), false);
});

test("CredentialResolutionError never puts its reference in the message", () => {
  const error = new CredentialResolutionError("keychain:team-secret-ref");
  assert.equal(error.name, "CredentialResolutionError");
  assert.equal(error.message.includes("team-secret-ref"), false);
});

test("HostRequestError classifies HTTP status without message parsing", () => {
  assert.equal(new HostRequestError(401, "x").code, "unauthorized");
  assert.equal(new HostRequestError(403, "x").code, "forbidden");
  assert.equal(new HostRequestError(404, "x").code, "not-found");
  assert.equal(new HostRequestError(422, "x").code, "bad-request");
  assert.equal(new HostRequestError(503, "x").code, "server-error");
  assert.equal(new HostRequestError(302, "x").code, "unknown");
});
