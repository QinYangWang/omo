import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDetachRequest,
  buildEventBatch,
  buildHeartbeatRequest,
  buildNativeEvent,
  buildRegisterRequest,
  checkPiPeerVersion,
  PI_PEER_VERSION,
  parseMajorMinor,
  readExtensionVersion,
  toJsonSafe,
} from "../daemon-channel.mjs";

const PEER_MISMATCH_RE = /pi_peer_version_mismatch/;

test("parseMajorMinor extracts the major/minor line", () => {
  assert.equal(parseMajorMinor("0.86.1"), "0.86");
  assert.equal(parseMajorMinor("0.86"), "0.86");
  assert.equal(parseMajorMinor("0.87.1-beta.2"), "0.87");
  assert.equal(parseMajorMinor("unknown"), null);
  assert.equal(parseMajorMinor(""), null);
  assert.equal(parseMajorMinor(undefined), null);
});

test("checkPiPeerVersion accepts the pinned line and rejects everything else", () => {
  assert.equal(PI_PEER_VERSION, "0.86");
  assert.deepEqual(checkPiPeerVersion("0.86.1"), {
    majorMinor: "0.86",
    ok: true,
  });
  assert.deepEqual(checkPiPeerVersion("0.86"), {
    majorMinor: "0.86",
    ok: true,
  });

  for (const version of ["0.87.0", "0.85.1", "1.0.0", "unknown", ""]) {
    const result = checkPiPeerVersion(version);
    assert.equal(result.ok, false, `${version} must be rejected`);
    assert.match(result.reason, PEER_MISMATCH_RE);
  }
});

test("readExtensionVersion reads package.json", () => {
  assert.equal(readExtensionVersion(), "0.1.0");
});

test("register envelope matches the frozen channel contract", () => {
  const request = buildRegisterRequest({
    cwd: "/workspace/project",
    extensionVersion: "0.1.0",
    instanceId: "11111111-1111-4111-8111-111111111111",
    piVersion: "unknown",
    sessionFile: "/sessions/a.jsonl",
    sessionId: "session-a",
  });
  assert.deepEqual(request, {
    capabilities: ["events", "commands"],
    channelVersion: 1,
    cwd: "/workspace/project",
    extensionVersion: "0.1.0",
    instanceId: "11111111-1111-4111-8111-111111111111",
    piVersion: "unknown",
    sessionFile: "/sessions/a.jsonl",
    sessionId: "session-a",
  });

  const minimal = buildRegisterRequest({
    cwd: "",
    extensionVersion: "0.1.0",
    instanceId: "11111111-1111-4111-8111-111111111111",
    piVersion: "unknown",
    sessionFile: undefined,
    sessionId: "session-a",
  });
  assert.equal("cwd" in minimal, false);
  assert.equal("sessionFile" in minimal, false);
});

test("heartbeat, event batch and detach envelopes are minimal", () => {
  assert.deepEqual(
    buildHeartbeatRequest({
      generation: 2,
      instanceId: "11111111-1111-4111-8111-111111111111",
    }),
    { generation: 2, instanceId: "11111111-1111-4111-8111-111111111111" }
  );

  const event = buildNativeEvent({
    event: "message_update",
    nativeSequence: 7,
    payload: { delta: "hi" },
    sessionFile: undefined,
    sessionId: "session-a",
    timestamp: 123,
  });
  assert.deepEqual(event, {
    event: "message_update",
    nativeSequence: 7,
    payload: { delta: "hi" },
    sessionId: "session-a",
    timestamp: 123,
  });
  assert.equal("sessionFile" in event, false);

  assert.deepEqual(
    buildEventBatch({
      events: [event],
      generation: 3,
      instanceId: "11111111-1111-4111-8111-111111111111",
    }),
    {
      events: [event],
      generation: 3,
      instanceId: "11111111-1111-4111-8111-111111111111",
    }
  );

  assert.deepEqual(
    buildDetachRequest({
      generation: 3,
      instanceId: "11111111-1111-4111-8111-111111111111",
    }),
    { generation: 3, instanceId: "11111111-1111-4111-8111-111111111111" }
  );
  assert.deepEqual(
    buildDetachRequest({
      generation: 3,
      instanceId: "11111111-1111-4111-8111-111111111111",
      reason: "quit",
    }),
    {
      generation: 3,
      instanceId: "11111111-1111-4111-8111-111111111111",
      reason: "quit",
    }
  );
});

test("toJsonSafe normalizes non-JSON payload values", () => {
  const circular = { name: "root" };
  circular.self = circular;
  const sanitized = toJsonSafe({
    big: 10n,
    circular,
    date: new Date("2020-01-02T03:04:05.000Z"),
    dropped: undefined,
    error: new Error("boom"),
    fn: () => undefined,
    list: [1, 2, 3],
  });
  assert.deepEqual(sanitized, {
    big: "10",
    circular: { name: "root", self: "[Circular]" },
    date: "2020-01-02T03:04:05.000Z",
    error: { message: "boom", name: "Error" },
    list: [1, 2, 3],
  });
  assert.equal("dropped" in sanitized, false);
  assert.equal("fn" in sanitized, false);
});
