import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerRequest, startDaemonHarness } from "./daemon-helpers.mjs";
import { EXTENSION_ENTRY, spawnPi } from "./helpers.mjs";

const PROMPT = "Reply with exactly: hello hello hello hello hello hello";
const TEST_TIMEOUT_MS = 180_000;
const INSTANCE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALREADY_ATTACHED_RE = /register rejected: session_already_attached/;
const PI_BASE_ARGS = [
  "--print",
  "--no-session",
  "--no-extensions",
  "--no-context-files",
  "--provider",
  "opencode-go",
  "--model",
  "deepseek-v4.1-flash",
];

const extensionLines = (stderr) =>
  stderr.split("\n").filter((line) => line.includes("[omo-pi-extension]"));

test("registers, heartbeats, forwards native events and detaches on exit", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  try {
    const pi = spawnPi({
      args: [...PI_BASE_ARGS, "--extension", EXTENSION_ENTRY, PROMPT],
      env: { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.85.0" },
    });
    const { code } = await pi.closed;
    const context = `code=${code}\nstderr:\n${pi.stderr}`;
    assert.equal(code, 0, `pi did not exit cleanly\n${context}`);

    // --- register -------------------------------------------------------
    assert.equal(
      daemon.registerCalls.length,
      1,
      `exactly one register request\n${context}`
    );
    const [registration] = daemon.registerCalls;
    assert.deepEqual(registration.capabilities, ["events", "commands"]);
    assert.equal(registration.channelVersion, 1);
    assert.equal(registration.piVersion, "0.85.0");
    assert.equal(registration.extensionVersion, "0.1.0");
    assert.match(registration.instanceId, INSTANCE_ID_RE);
    assert.equal(typeof registration.sessionId, "string");
    assert.ok(registration.sessionId.length > 0);
    assert.equal(
      daemon.nativeEvents[0]?.attachment.generation,
      1,
      "first accepted generation is 1"
    );

    // --- heartbeat keeps the lease alive --------------------------------
    assert.ok(
      daemon.heartbeatCalls.length >= 1,
      `at least one heartbeat during the run\n${context}`
    );
    assert.ok(
      daemon.detaches.every((entry) => entry.reason !== "heartbeat-timeout"),
      `lease never expired mid-run\n${context}`
    );

    // --- native event forwarding ----------------------------------------
    const events = daemon.nativeEvents.map((entry) => entry.event);
    const byEvent = (name) => events.filter((event) => event.event === name);
    const observed = events.map((event) => event.event).join(", ");
    assert.ok(
      byEvent("session_start").length === 1,
      `session_start forwarded\n${context}\n[${observed}]`
    );
    assert.ok(
      byEvent("turn_start").length >= 1,
      `turn_start forwarded\n${context}\n[${observed}]`
    );
    assert.ok(
      byEvent("turn_end").length >= 1,
      `turn_end forwarded\n${context}\n[${observed}]`
    );
    assert.ok(
      byEvent("agent_end").length + byEvent("agent_settled").length >= 1,
      `agent_end/agent_settled forwarded\n${context}\n[${observed}]`
    );

    const deltas = events
      .filter((event) => event.event === "message_update")
      .map((event) => event.payload?.assistantMessageEvent)
      .filter(
        (delta) =>
          delta?.type === "text_delta" &&
          typeof delta.delta === "string" &&
          delta.delta.length > 0
      );
    assert.ok(
      deltas.length >= 2,
      `at least two streaming deltas\n${context}\n[${observed}]`
    );

    const sequences = daemon.nativeEvents.map(
      (entry) => entry.event.nativeSequence
    );
    assert.equal(Math.min(...sequences), 1);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(
        sequences[index] > sequences[index - 1],
        `nativeSequence increases at ${index}: ${sequences.join(",")}`
      );
    }
    for (const batch of daemon.eventBatches) {
      assert.equal(batch.generation, 1);
    }

    // --- detach on process exit -----------------------------------------
    assert.ok(
      daemon.detaches.length >= 1,
      `process exit produces a detach\n${context}`
    );
    assert.equal(daemon.detaches.at(-1).reason, "session_shutdown");
  } finally {
    await daemon.close();
  }
});

test("stays inert when OMO_DAEMON_SOCKET is unset", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  try {
    const pi = spawnPi({
      args: [...PI_BASE_ARGS, "--extension", EXTENSION_ENTRY, PROMPT],
      env: {},
    });
    const { code } = await pi.closed;
    assert.equal(code, 0, `pi did not exit cleanly\n${pi.stderr}`);
    assert.equal(
      daemon.requests.length,
      0,
      `daemon received no requests: ${JSON.stringify(daemon.requests)}`
    );
    assert.equal(daemon.registerCalls.length, 0);
  } finally {
    await daemon.close();
  }
});

test("a rejected register runs detached-local without a retry loop", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  const sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omo-pi-ext-session-")
  );
  const sessionId = "e2-rejected-session";
  try {
    // Occupy the session so the extension's register is rejected.
    const occupied = await daemon.service.register(
      registerRequest({ sessionId })
    );
    assert.equal(occupied.ok, true);
    assert.equal(occupied.generation, 1);

    const pi = spawnPi({
      args: [
        "--print",
        "--no-extensions",
        "--no-context-files",
        "--provider",
        "opencode-go",
        "--model",
        "deepseek-v4.1-flash",
        "--session-id",
        sessionId,
        "--session-dir",
        sessionDir,
        "--extension",
        EXTENSION_ENTRY,
        PROMPT,
      ],
      env: { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.85.0" },
    });
    const { code } = await pi.closed;
    const context = `code=${code}\nstderr:\n${pi.stderr}`;
    assert.equal(code, 0, `pi did not exit cleanly\n${context}`);

    const lines = extensionLines(pi.stderr);
    assert.equal(lines.length, 1, `exactly one extension log line\n${context}`);
    assert.match(lines[0], ALREADY_ATTACHED_RE);

    // Only the rejected register reached the daemon over HTTP: no heartbeat,
    // events or detach from the detached-local instance.
    assert.equal(
      daemon.requests.length,
      1,
      `no requests after the rejected register: ${JSON.stringify(daemon.requests)}`
    );
    assert.equal(daemon.requests[0].pathname, "/api/v1/extension/register");
    assert.equal(daemon.eventBatches.length, 0);
    assert.equal(daemon.detachCalls.length, 0);
    assert.equal(daemon.heartbeatCalls.length, 0);
  } finally {
    fs.rmSync(sessionDir, { force: true, recursive: true });
    await daemon.close();
  }
});
