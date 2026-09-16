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
const TEST_TIMEOUT_MS = 180_000;
const CHILD_TIMEOUT_MS = 170_000;
const READY_TIMEOUT_MS = 30_000;
const ACK_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 60_000;

const PROMPT_ONE = "Reply with exactly: hello hello hello hello hello hello";
const PROMPT_TWO =
  "Write out the integers from 1 to 400, one per line, with no other text.";

const UNKNOWN_TYPE_RE = /unknown_command_type/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startHarness = () => {
  const events = [];
  const commandClients = new Set();
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/events") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          // Ignore malformed bodies; assertions below surface missing records.
        }
        response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      });
      return;
    }
    if (request.method === "GET" && request.url === "/commands") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(": omo command stream connected\n\n");
      commandClients.add(response);
      request.on("close", () => {
        commandClients.delete(response);
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        ackFor(requestId, status) {
          return events.find(
            (record) =>
              record.kind === "ack" &&
              record.requestId === requestId &&
              record.status === status
          );
        },
        acksFor(requestId, status) {
          return events.filter(
            (record) =>
              record.kind === "ack" &&
              record.requestId === requestId &&
              record.status === status
          );
        },
        commandClients,
        events,
        hasCommandClient() {
          return commandClients.size > 0;
        },
        nativeEvents() {
          return events.filter((record) => record.kind !== "ack");
        },
        sendCommand(command) {
          const frame = `data: ${JSON.stringify(command)}\n\n`;
          for (const client of commandClients) {
            client.write(frame);
          }
          return commandClients.size;
        },
        server,
        textDeltas(sinceIndex = 0) {
          return events
            .slice(sinceIndex)
            .filter((record) => record.event === "message_update")
            .map((record) => record.payload?.assistantMessageEvent)
            .filter(
              (delta) =>
                delta?.type === "text_delta" &&
                typeof delta.delta === "string" &&
                delta.delta.length > 0
            );
        },
        url: {
          commands: `${origin}/commands`,
          events: `${origin}/events`,
        },
      });
    });
  });
};

const spawnPiRpc = (urls) => {
  const child = spawn(
    PI_BINARY,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--provider",
      "opencode-go",
      "--model",
      "deepseek-v4.1-flash",
      "--extension",
      EXTENSION_ENTRY,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        OMO_EXTENSION_COMMANDS_URL: urls.commands,
        OMO_EXTENSION_EVENTS_URL: urls.events,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  const closed = new Promise((resolve) => {
    child.once("close", (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });
  const stop = async () => {
    // Closing stdin triggers the documented RPC graceful shutdown path.
    child.stdin.end();
    const code = await Promise.race([
      closed,
      delay(5000).then(() => "timeout"),
    ]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      await closed;
    }
  };
  return {
    child,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    stop,
  };
};

const waitFor = (predicate, { label, timeout = ACK_TIMEOUT_MS }) => {
  const deadline = Date.now() + timeout;
  const poll = async () => {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(25);
    return poll();
  };
  return poll();
};

test("injects prompt and abort into the same live native session via the command bridge", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const harness = await startHarness();
  const pi = spawnPiRpc(harness.url);
  const context = () =>
    `\nstderr:\n${pi.stderr}\nacks=[${harness.events
      .filter((record) => record.kind === "ack")
      .map((record) => `${record.requestId}:${record.status}`)
      .join(", ")}]\n`;

  try {
    // The extension connects OUT to the harness command stream from
    // session_start; the harness never dials into the Pi process.
    await waitFor(() => harness.hasCommandClient(), {
      label: "extension to open the outbound command stream",
      timeout: READY_TIMEOUT_MS,
    });
    await waitFor(
      () => harness.nativeEvents().some((r) => r.event === "session_start"),
      {
        label: "session_start to be forwarded",
        timeout: READY_TIMEOUT_MS,
      }
    );

    // --- Prompt: accepted -> started -> deltas -> completed ---------------
    assert.equal(
      harness.sendCommand({
        commandSequence: 1,
        requestId: "prompt-1",
        text: PROMPT_ONE,
        type: "prompt",
      }),
      1,
      "exactly one command stream client is connected"
    );
    await waitFor(() => harness.ackFor("prompt-1", "accepted"), {
      label: "prompt-1 accepted ack",
    });
    await waitFor(() => harness.ackFor("prompt-1", "started"), {
      label: "prompt-1 started ack",
    });
    await waitFor(() => harness.textDeltas().length >= 2, {
      label: "assistant streaming deltas for the injected prompt",
    });
    await waitFor(() => harness.ackFor("prompt-1", "completed"), {
      label: "prompt-1 completed ack",
      timeout: SETTLE_TIMEOUT_MS,
    });
    assert.ok(
      harness.acksFor("prompt-1", "accepted")[0].nativeSequence <
        harness.acksFor("prompt-1", "started")[0].nativeSequence,
      `accepted precedes started${context()}`
    );
    assert.ok(
      harness.acksFor("prompt-1", "started")[0].nativeSequence <
        harness.acksFor("prompt-1", "completed")[0].nativeSequence,
      `started precedes completed${context()}`
    );

    // --- Duplicate requestId must not execute twice ------------------------
    const agentStartsBefore = harness
      .nativeEvents()
      .filter((r) => r.event === "agent_start").length;
    const userMessagesBefore = harness
      .nativeEvents()
      .filter(
        (r) =>
          r.event === "message_start" && r.payload?.message?.role === "user"
      ).length;
    harness.sendCommand({
      commandSequence: 2,
      requestId: "prompt-1",
      text: "this duplicate must never run",
      type: "prompt",
    });
    const duplicateAck = await waitFor(
      () => harness.ackFor("prompt-1", "rejected"),
      { label: "duplicate requestId rejected ack" }
    );
    assert.equal(
      duplicateAck.reason,
      "duplicate_request",
      `duplicate rejection reason${context()}`
    );
    await delay(1500);
    assert.equal(
      harness.nativeEvents().filter((r) => r.event === "agent_start").length,
      agentStartsBefore,
      `duplicate prompt did not start a second run${context()}`
    );
    assert.equal(
      harness
        .nativeEvents()
        .filter(
          (r) =>
            r.event === "message_start" && r.payload?.message?.role === "user"
        ).length,
      userMessagesBefore,
      `duplicate prompt did not add a user message${context()}`
    );

    // --- Rejected envelope shapes -----------------------------------------
    harness.sendCommand({
      commandSequence: 3,
      requestId: "empty-1",
      text: "   ",
      type: "prompt",
    });
    const emptyAck = await waitFor(
      () => harness.ackFor("empty-1", "rejected"),
      {
        label: "empty text rejected ack",
      }
    );
    assert.equal(
      emptyAck.reason,
      "empty_text",
      `empty text reason${context()}`
    );

    harness.sendCommand({
      commandSequence: 4,
      requestId: "unknown-1",
      type: "nonsense",
    });
    const unknownAck = await waitFor(
      () => harness.ackFor("unknown-1", "rejected"),
      { label: "unknown type rejected ack" }
    );
    assert.match(
      unknownAck.reason,
      UNKNOWN_TYPE_RE,
      `unknown type reason${context()}`
    );

    // --- Stale commandSequence is ignored ---------------------------------
    harness.sendCommand({
      commandSequence: 2,
      requestId: "stale-1",
      text: "stale",
      type: "prompt",
    });
    await delay(500);
    assert.equal(
      harness.ackFor("stale-1", "accepted"),
      undefined,
      `stale command is not applied${context()}`
    );
    assert.equal(
      harness.ackFor("stale-1", "rejected"),
      undefined,
      `stale command is not acked${context()}`
    );

    // --- Abort: mid-stream native abort ----------------------------------
    const mark = harness.events.length;
    harness.sendCommand({
      commandSequence: 5,
      requestId: "prompt-2",
      text: PROMPT_TWO,
      type: "prompt",
    });
    await waitFor(() => harness.ackFor("prompt-2", "accepted"), {
      label: "prompt-2 accepted ack",
    });
    await waitFor(() => harness.ackFor("prompt-2", "started"), {
      label: "prompt-2 started ack",
    });
    await waitFor(() => harness.textDeltas(mark).length >= 1, {
      label: "prompt-2 streaming deltas",
    });
    assert.equal(
      harness.ackFor("prompt-2", "completed"),
      undefined,
      `prompt-2 is still streaming before abort${context()}`
    );

    harness.sendCommand({
      commandSequence: 6,
      requestId: "abort-1",
      type: "abort",
    });
    const abortAccepted = await waitFor(
      () => harness.ackFor("abort-1", "accepted"),
      { label: "abort accepted ack" }
    );
    await waitFor(() => harness.ackFor("prompt-2", "completed"), {
      label: "prompt-2 completed ack after abort",
      timeout: SETTLE_TIMEOUT_MS,
    });
    const abortCompleted = await waitFor(
      () => harness.ackFor("abort-1", "completed"),
      { label: "abort completed ack", timeout: SETTLE_TIMEOUT_MS }
    );

    const promptCompleted = harness.ackFor("prompt-2", "completed");
    assert.ok(
      abortAccepted.nativeSequence < promptCompleted.nativeSequence,
      `abort accepted precedes prompt completion${context()}`
    );
    assert.ok(
      promptCompleted.nativeSequence < abortCompleted.nativeSequence,
      `prompt completion precedes abort completion${context()}`
    );
    assert.equal(
      abortCompleted.reason,
      "aborted",
      `abort completion reports the native stop reason${context()}`
    );

    const abortedAssistantMessages = harness
      .nativeEvents()
      .filter(
        (record) =>
          record.event === "message_end" &&
          record.payload?.message?.role === "assistant" &&
          record.payload.message.stopReason === "aborted"
      );
    assert.ok(
      abortedAssistantMessages.length >= 1,
      `native runtime reports an aborted assistant message${context()}`
    );
    const earlyEnds = harness
      .nativeEvents()
      .slice(mark)
      .filter(
        (record) => record.event === "turn_end" || record.event === "agent_end"
      );
    assert.ok(
      earlyEnds.length >= 1,
      `turn/agent end observed after abort${context()}`
    );

    // --- Shared envelope conventions --------------------------------------
    const instanceIds = new Set(
      harness.events.map((record) => record.instanceId)
    );
    assert.equal(
      instanceIds.size,
      1,
      `all records share one instanceId${context()}`
    );
    const sequences = harness.events.map((record) => record.nativeSequence);
    assert.equal(Math.min(...sequences), 1, "nativeSequence starts at 1");
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(
        sequences[index] > sequences[index - 1],
        `nativeSequence increases at index ${index}${context()}`
      );
    }
  } finally {
    await pi.stop();
    for (const client of harness.commandClients) {
      client.end();
    }
    harness.server.closeAllConnections?.();
    await new Promise((resolve) => harness.server.close(resolve));
  }
});
