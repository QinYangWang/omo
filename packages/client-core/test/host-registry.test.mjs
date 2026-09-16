import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserHostEndpoint,
  findHostRegistryEntryByEndpoint,
  hostEndpointKey,
  hostEndpointLabel,
  isBrowserHostTransport,
  isLocalHostTransport,
  normalizeHostEndpoint,
  normalizeHttpHostUrl,
  reassignHostEndpoint,
  reconcileHostIdentity,
} from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const OTHER_HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f3";

const CREDENTIALS_PATTERN = /credentials/;
const HTTP_OR_HTTPS_PATTERN = /HTTP or HTTPS/;
const INVALID_URL_PATTERN = /Invalid Host URL/;
const TRANSPORT_MISMATCH_PATTERN = /does not match/;
const ABSOLUTE_PATH_PATTERN = /absolute/;
const NAMED_PIPE_PATTERN = /named pipe/;
const INVALID_HOST_ID_PATTERN = /Invalid/;
const UNIX_BROWSER_PATTERN = /cannot use unix/;
const PIPE_BROWSER_PATTERN = /cannot use pipe/;

test("HTTP Host URLs normalize to one canonical identity", () => {
  assert.equal(
    normalizeHttpHostUrl("  HTTPS://Host.Example:443/  "),
    "https://host.example"
  );
  assert.equal(
    normalizeHttpHostUrl("http://127.0.0.1:5189///"),
    "http://127.0.0.1:5189"
  );
  assert.equal(
    normalizeHttpHostUrl("http://127.0.0.1:5189/?a=1#fragment"),
    "http://127.0.0.1:5189"
  );
  assert.throws(
    () => normalizeHttpHostUrl("http://user:pass@host.example"),
    CREDENTIALS_PATTERN
  );
  assert.throws(
    () => normalizeHttpHostUrl("ws://host.example"),
    HTTP_OR_HTTPS_PATTERN
  );
  assert.throws(() => normalizeHttpHostUrl("not a url"), INVALID_URL_PATTERN);
});

test("Host endpoints normalize per transport", () => {
  assert.deepEqual(
    normalizeHostEndpoint({
      transport: "https",
      url: "https://Host.Example:443/",
    }),
    { transport: "https", url: "https://host.example" }
  );
  assert.throws(
    () =>
      normalizeHostEndpoint({ transport: "http", url: "https://host.example" }),
    TRANSPORT_MISMATCH_PATTERN
  );
  assert.deepEqual(
    normalizeHostEndpoint({ path: " /run/omo.sock/ ", transport: "unix" }),
    { path: "/run/omo.sock", transport: "unix" }
  );
  assert.throws(
    () => normalizeHostEndpoint({ path: "relative.sock", transport: "unix" }),
    ABSOLUTE_PATH_PATTERN
  );
  assert.deepEqual(
    normalizeHostEndpoint({ path: "\\\\.\\pipe\\omo", transport: "pipe" }),
    { path: "\\\\.\\pipe\\omo", transport: "pipe" }
  );
  assert.throws(
    () => normalizeHostEndpoint({ path: "omo", transport: "pipe" }),
    NAMED_PIPE_PATTERN
  );
});

test("Duplicate detection uses the normalized endpoint, not the Host identity", () => {
  assert.equal(
    hostEndpointKey({ transport: "https", url: "https://Host.Example:443/" }),
    "https://host.example"
  );
  assert.equal(
    hostEndpointLabel({ path: "/run/omo.sock", transport: "unix" }),
    "unix:/run/omo.sock"
  );
  assert.equal(
    hostEndpointLabel({ path: "\\\\.\\pipe\\omo", transport: "pipe" }),
    "pipe:\\\\.\\pipe\\omo"
  );

  const entries = [
    {
      endpoint: { transport: "https", url: "https://host.example/" },
      expectedHostId: HOST_ID,
      id: "alias-a",
      label: "Primary endpoint",
    },
    {
      endpoint: { transport: "https", url: "https://host.example:8443" },
      expectedHostId: HOST_ID,
      id: "alias-b",
      label: "Secondary endpoint",
    },
  ];
  assert.equal(
    findHostRegistryEntryByEndpoint(entries, {
      transport: "https",
      url: "https://HOST.example",
    })?.id,
    "alias-a"
  );
  assert.equal(
    findHostRegistryEntryByEndpoint(entries, {
      transport: "https",
      url: "https://missing.example",
    }),
    undefined
  );
  // Two endpoints for the same Host stay independent aliases.
  assert.equal(
    entries.filter((entry) => entry.expectedHostId === HOST_ID).length,
    2
  );
});

test("Host identity reconciliation covers first connection, match and mismatch", () => {
  const entry = {
    endpoint: { transport: "https", url: "https://host.example" },
    id: "entry-1",
    label: "Host",
  };
  assert.deepEqual(reconcileHostIdentity(entry, HOST_ID), {
    hostId: HOST_ID,
    kind: "first-connection",
  });
  const pinned = { ...entry, expectedHostId: HOST_ID };
  assert.deepEqual(reconcileHostIdentity(pinned, HOST_ID), {
    hostId: HOST_ID,
    kind: "matching",
  });
  assert.deepEqual(reconcileHostIdentity(pinned, OTHER_HOST_ID), {
    expectedHostId: HOST_ID,
    kind: "mismatch",
    observedHostId: OTHER_HOST_ID,
  });
  assert.throws(
    () => reconcileHostIdentity(pinned, "bad-host-id"),
    INVALID_HOST_ID_PATTERN
  );
});

test("Restarting the same Host installation matches instead of mismatching", () => {
  // `hostId` is persisted in the Host data directory (server/host-identity.cjs),
  // so a restarted Host reports the same id and must not be flagged as replaced.
  const pinned = {
    endpoint: { transport: "https", url: "https://host.example" },
    expectedHostId: HOST_ID,
    id: "entry-1",
    label: "Host",
  };
  assert.deepEqual(reconcileHostIdentity(pinned, HOST_ID), {
    hostId: HOST_ID,
    kind: "matching",
  });
});

test("Endpoint reassignment clears the pinned identity for re-verification", () => {
  const pinned = {
    credentialRef: "keychain:omo/team",
    endpoint: { transport: "http", url: "http://old.example:5189" },
    expectedHostId: HOST_ID,
    id: "entry-1",
    label: "Team Host",
  };
  const next = reassignHostEndpoint(pinned, {
    transport: "https",
    url: "https://new.example/",
  });
  assert.deepEqual(next, {
    credentialRef: "keychain:omo/team",
    endpoint: { transport: "https", url: "https://new.example" },
    id: "entry-1",
    label: "Team Host",
  });
  assert.equal("expectedHostId" in next, false);
});

test("Browsers only accept HTTP and HTTPS endpoints", () => {
  assert.equal(isLocalHostTransport("unix"), true);
  assert.equal(isLocalHostTransport("pipe"), true);
  assert.equal(isLocalHostTransport("http"), false);
  assert.equal(isBrowserHostTransport("https"), true);
  assert.doesNotThrow(() =>
    assertBrowserHostEndpoint({
      transport: "https",
      url: "https://host.example",
    })
  );
  assert.throws(
    () =>
      assertBrowserHostEndpoint({ path: "/run/omo.sock", transport: "unix" }),
    UNIX_BROWSER_PATTERN
  );
  assert.throws(
    () =>
      assertBrowserHostEndpoint({
        path: "\\\\.\\pipe\\omo",
        transport: "pipe",
      }),
    PIPE_BROWSER_PATTERN
  );
});
