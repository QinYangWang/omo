import assert from "node:assert/strict";
import test from "node:test";
import {
  addHostRegistryEntry,
  createEmptyHostRegistryDocument,
  findHostRegistryEntry,
  removeHostRegistryEntry,
  resolveSelectedHostRegistryEntry,
  selectHostRegistryEntry,
  updateHostRegistryEntry,
} from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const DUPLICATE_PATTERN = /already configured/;
const UNKNOWN_PATTERN = /Unknown Host entry/;

function add(document, label, url, extra = {}) {
  return addHostRegistryEntry(document, {
    endpoint: { transport: "https", url },
    label,
    ...extra,
  });
}

test("empty registry has the versioned schema and no selection", () => {
  const document = createEmptyHostRegistryDocument();
  assert.equal(document.schema, "omo.host-registry");
  assert.equal(document.version, 1);
  assert.deepEqual(document.entries, []);
  assert.equal("selectedEntryId" in document, false);
});

test("adding an entry normalizes the endpoint and rejects duplicates", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "Team",
    "HTTPS://Host.example:443/"
  );
  assert.equal(first.entry.endpoint.url, "https://host.example");
  assert.equal(first.document.entries.length, 1);

  assert.throws(
    () => add(first.document, "Alias", "https://host.example"),
    DUPLICATE_PATTERN
  );
});

test("removing the selected entry clears the selection", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "Team",
    "https://host.example"
  );
  const selected = selectHostRegistryEntry(first.document, first.entry.id);
  assert.equal(selected.selectedEntryId, first.entry.id);

  const removed = removeHostRegistryEntry(selected, first.entry.id);
  assert.deepEqual(removed.document.entries, []);
  assert.equal("selectedEntryId" in removed.document, false);
  assert.equal(removed.entry.id, first.entry.id);
});

test("removing an unknown entry is a hard error", () => {
  assert.throws(
    () => removeHostRegistryEntry(createEmptyHostRegistryDocument(), "missing"),
    UNKNOWN_PATTERN
  );
});

test("updating the label keeps the pinned identity", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "Team",
    "https://host.example"
  );
  const pinned = updateHostRegistryEntry(first.document, first.entry.id, {
    label: "Team A",
  });
  assert.equal(pinned.entry.label, "Team A");
  assert.equal(pinned.entry.expectedHostId, undefined);

  const withIdentity = {
    ...pinned.document,
    entries: [{ ...pinned.entry, expectedHostId: HOST_ID }],
  };
  const relabeled = updateHostRegistryEntry(withIdentity, first.entry.id, {
    label: "Team B",
  });
  assert.equal(relabeled.entry.expectedHostId, HOST_ID);
});

test("reassigning the endpoint clears the pinned identity", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "Team",
    "https://old.example"
  );
  const withIdentity = {
    ...first.document,
    entries: [{ ...first.entry, expectedHostId: HOST_ID }],
  };
  const moved = updateHostRegistryEntry(withIdentity, first.entry.id, {
    endpoint: { transport: "https", url: "https://new.example/" },
  });
  assert.equal(moved.entry.endpoint.url, "https://new.example");
  assert.equal(moved.entry.expectedHostId, undefined);
  assert.equal(moved.entry.id, first.entry.id);
});

test("rotating the credential keeps the entry id and pinned identity", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "Team",
    "https://host.example",
    {
      credentialRef: "vault:one",
    }
  );
  const withIdentity = {
    ...first.document,
    entries: [{ ...first.entry, expectedHostId: HOST_ID }],
  };
  const rotated = updateHostRegistryEntry(withIdentity, first.entry.id, {
    credentialRef: "vault:two",
  });
  assert.equal(rotated.entry.id, first.entry.id);
  assert.equal(rotated.entry.credentialRef, "vault:two");
  assert.equal(rotated.entry.expectedHostId, HOST_ID);
});

test("updating onto another entry's endpoint is rejected", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "One",
    "https://one.example"
  );
  const second = add(first.document, "Two", "https://two.example");
  assert.throws(
    () =>
      updateHostRegistryEntry(second.document, second.entry.id, {
        endpoint: { transport: "https", url: "https://one.example" },
      }),
    DUPLICATE_PATTERN
  );
});

test("selection and resolution follow the registry", () => {
  const first = add(
    createEmptyHostRegistryDocument(),
    "One",
    "https://one.example"
  );
  const second = add(first.document, "Two", "https://two.example");
  const selected = selectHostRegistryEntry(second.document, second.entry.id);
  assert.equal(resolveSelectedHostRegistryEntry(selected)?.id, second.entry.id);
  assert.equal(findHostRegistryEntry(selected, first.entry.id)?.label, "One");

  const cleared = selectHostRegistryEntry(selected, null);
  assert.equal(resolveSelectedHostRegistryEntry(cleared), undefined);

  assert.throws(
    () => selectHostRegistryEntry(selected, "missing"),
    UNKNOWN_PATTERN
  );
});
