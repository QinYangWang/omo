import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-hooks.mjs", import.meta.url);

const {
  addHostRegistryEntry,
  applyHostIdentityPin,
  createEmptyHostRegistryDocument,
  selectHostRegistryEntry,
} = await import("../packages/client-core/dist/index.js");
const { resolveServerTarget } = await import(
  "../src/lib/host-registry-model.ts"
);

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const UNKNOWN_PATTERN = /Unknown Host entry/;

function add(document, id, label, url, extra = {}) {
  return addHostRegistryEntry(document, {
    endpoint: { transport: "https", url },
    id,
    label,
    ...extra,
  });
}

test("explicit server ids never fall back to another Host", () => {
  const servers = [{ id: "one" }, { id: "two" }];

  assert.equal(resolveServerTarget(servers, "two", "one"), servers[1]);
  assert.throws(
    () => resolveServerTarget(servers, "removed", "one"),
    UNKNOWN_PATTERN
  );
  // Even an empty registry is a hard error when the id was explicit; the
  // preview fallback must only apply to the default path.
  assert.throws(
    () => resolveServerTarget([], "local", "local"),
    UNKNOWN_PATTERN
  );
});

test("the default path still falls back to the first configured Host", () => {
  const servers = [{ id: "one" }, { id: "two" }];

  assert.equal(resolveServerTarget(servers, undefined, "two"), servers[1]);
  assert.equal(resolveServerTarget(servers, undefined, "missing"), servers[0]);
  assert.equal(resolveServerTarget([], undefined, "local"), undefined);
});

test("a stale pin never reverts an endpoint edit made during the probe", () => {
  const added = add(
    createEmptyHostRegistryDocument(),
    "entry-1",
    "Old label",
    "https://old.example",
    { credentialRef: "vault:one" }
  );
  const withSecond = add(
    added.document,
    "entry-2",
    "Second",
    "https://second.example"
  );
  const selected = selectHostRegistryEntry(withSecond.document, "entry-2");
  // The user edits URL, label and credential while the probe is in flight.
  const edited = {
    ...selected,
    entries: selected.entries.map((candidate) =>
      candidate.id === "entry-1"
        ? {
            ...candidate,
            credentialRef: "vault:two",
            endpoint: { transport: "https", url: "https://new.example" },
            label: "New label",
          }
        : candidate
    ),
  };

  const { applied, document } = applyHostIdentityPin(edited, {
    endpoint: { transport: "https", url: "https://old.example" },
    entryId: "entry-1",
    expectedHostId: HOST_ID,
  });

  assert.equal(applied, false);
  assert.equal(document, edited);
  const target = document.entries.find(
    (candidate) => candidate.id === "entry-1"
  );
  assert.equal(target.endpoint.url, "https://new.example");
  assert.equal(target.label, "New label");
  assert.equal(target.credentialRef, "vault:two");
  assert.equal(target.expectedHostId, undefined);
});

test("a matching pin updates only expectedHostId and preserves the rest", () => {
  const added = add(
    createEmptyHostRegistryDocument(),
    "entry-1",
    "Old label",
    "https://old.example/",
    { credentialRef: "vault:one" }
  );
  const withSecond = add(
    added.document,
    "entry-2",
    "Second",
    "https://second.example"
  );
  const selected = selectHostRegistryEntry(withSecond.document, "entry-2");
  // Endpoint is unchanged but label/credential were rotated during the probe;
  // the probed URL has a trailing slash so normalization must still match.
  const edited = {
    ...selected,
    entries: selected.entries.map((candidate) =>
      candidate.id === "entry-1"
        ? { ...candidate, credentialRef: "vault:two", label: "New label" }
        : candidate
    ),
  };

  const { applied, document } = applyHostIdentityPin(edited, {
    endpoint: { transport: "https", url: "https://old.example" },
    entryId: "entry-1",
    expectedHostId: HOST_ID,
  });

  assert.equal(applied, true);
  assert.equal(document.selectedEntryId, "entry-2");
  assert.equal(document.entries.length, 2);
  const target = document.entries.find(
    (candidate) => candidate.id === "entry-1"
  );
  assert.equal(target.expectedHostId, HOST_ID);
  assert.equal(target.endpoint.url, "https://old.example");
  assert.equal(target.label, "New label");
  assert.equal(target.credentialRef, "vault:two");
});

test("a pin merges into the latest document without deleting concurrent hosts", () => {
  // The CLI captures a document before the network probe. Between that read
  // and the successful health, another process adds a Host and selects it.
  const beforeProbe = add(
    createEmptyHostRegistryDocument(),
    "entry-1",
    "Team",
    "https://host.example"
  ).document;
  const latest = selectHostRegistryEntry(
    add(beforeProbe, "entry-2", "Concurrent", "https://concurrent.example")
      .document,
    "entry-2"
  );

  const { applied, document } = applyHostIdentityPin(latest, {
    endpoint: { transport: "https", url: "https://host.example/" },
    entryId: "entry-1",
    expectedHostId: HOST_ID,
  });

  assert.equal(applied, true);
  assert.equal(document.selectedEntryId, "entry-2");
  assert.equal(document.entries.length, 2);
  assert.equal(
    document.entries.find((entry) => entry.id === "entry-2")?.label,
    "Concurrent"
  );
  assert.equal(
    document.entries.find((entry) => entry.id === "entry-1")?.expectedHostId,
    HOST_ID
  );
});

test("pins are ignored when the entry is removed or already pinned", () => {
  const added = add(
    createEmptyHostRegistryDocument(),
    "entry-1",
    "Team",
    "https://host.example"
  );

  const removed = applyHostIdentityPin(added.document, {
    endpoint: { transport: "https", url: "https://host.example" },
    entryId: "missing",
    expectedHostId: HOST_ID,
  });
  assert.equal(removed.applied, false);

  const pinned = {
    ...added.document,
    entries: [{ ...added.entry, expectedHostId: HOST_ID }],
  };
  const ignored = applyHostIdentityPin(pinned, {
    endpoint: { transport: "https", url: "https://host.example" },
    entryId: "entry-1",
    expectedHostId: HOST_ID,
  });
  assert.equal(ignored.applied, false);
  assert.equal(ignored.document, pinned);
});
