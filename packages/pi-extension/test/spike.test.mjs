import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const EXTENSION_ENTRY = path.join(PACKAGE_ROOT, "index.js");
const PI_BINARY = path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const TEST_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 110_000;
const PROMPT = "Reply with exactly: hello hello hello hello hello hello";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const byEvent = (events, name) =>
  events.filter((event) => event.event === name);

const startReceiver = () => {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        // Ignore malformed bodies; assertions below surface missing events.
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        received,
        server,
        url: `http://127.0.0.1:${address.port}/events`,
      });
    });
  });
};

const runPi = (eventsUrl) =>
  new Promise((resolve) => {
    const child = spawn(
      PI_BINARY,
      [
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-context-files",
        "--provider",
        "opencode-go",
        "--model",
        "deepseek-v4.1-flash",
        "--extension",
        EXTENSION_ENTRY,
        PROMPT,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NO_COLOR: "1",
          OMO_EXTENSION_EVENTS_URL: eventsUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error, stderr, stdout });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });

test("forwards native Pi lifecycle and token deltas to a local receiver", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const receiver = await startReceiver();
  try {
    const result = await runPi(receiver.url);
    await delay(250);
    const events = receiver.received;
    const observed = events.map((event) => event.event).join(", ");
    const context = `code=${result.code}\nevents=[${observed}]\nstderr:\n${result.stderr}`;

    assert.equal(result.code, 0, `pi did not exit cleanly\n${context}`);
    assert.ok(events.length > 0, `receiver observed no events\n${context}`);

    const instanceIds = new Set(events.map((event) => event.instanceId));
    assert.equal(
      instanceIds.size,
      1,
      `all events share one instanceId\n${context}`
    );
    const [instanceId] = instanceIds;
    assert.ok(
      UUID_RE.test(instanceId),
      `instanceId is not a UUID: ${instanceId}`
    );

    const sequences = events.map((event) => event.nativeSequence);
    assert.equal(Math.min(...sequences), 1, "nativeSequence starts at 1");
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(
        sequences[index] > sequences[index - 1],
        `nativeSequence is not increasing at index ${index}: ${sequences.join(",")}`
      );
    }

    assert.equal(
      byEvent(events, "session_start").length,
      1,
      "exactly one session_start is observed"
    );
    assert.ok(
      byEvent(events, "session_shutdown").length >= 1,
      "session_shutdown is forwarded"
    );
    assert.ok(
      byEvent(events, "agent_start").length >= 1,
      "agent_start is forwarded"
    );
    assert.ok(
      byEvent(events, "turn_start").length >= 1,
      "turn_start is forwarded"
    );
    assert.ok(byEvent(events, "turn_end").length >= 1, "turn_end is forwarded");

    const assistantEnds = byEvent(events, "message_end").filter(
      (event) => event.payload?.message?.role === "assistant"
    );
    assert.ok(assistantEnds.length >= 1, "assistant message_end is forwarded");

    const textDeltas = byEvent(events, "message_update")
      .filter(
        (event) =>
          event.payload?.message?.role === "assistant" &&
          event.payload?.assistantMessageEvent?.type === "text_delta"
      )
      .map((event) => event.payload.assistantMessageEvent.delta)
      .filter((delta) => typeof delta === "string" && delta.length > 0);
    assert.ok(
      textDeltas.length >= 2,
      `expected at least 2 streaming text deltas, got ${textDeltas.length}`
    );
    assert.ok(
      new Set(textDeltas).size >= 2,
      `expected distinct text deltas, got ${JSON.stringify(textDeltas)}`
    );

    const sessionIds = new Set(
      events
        .map((event) => event.sessionId)
        .filter((value) => typeof value === "string" && value.length > 0)
    );
    assert.ok(
      sessionIds.size >= 1,
      "sessionId is forwarded from event context"
    );
  } finally {
    receiver.server.closeAllConnections?.();
    await new Promise((resolve) => receiver.server.close(resolve));
  }
});
