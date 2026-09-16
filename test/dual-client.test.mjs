import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HttpHostClient } from "../packages/client-core/dist/index.js";

const SESSION_ID = "session-1";

const openResponse = {
  contextUsage: null,
  cursor: 0,
  eventSequence: 0,
  hasMore: false,
  isStreaming: false,
  messages: [],
  model: null,
  sessionFile: "/sessions/session-1.jsonl",
  sessionId: SESSION_ID,
  thinkingLevel: "medium",
};

const json = (response, value) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

test("two Host clients attach to one Session event stream", async () => {
  const streams = new Set();
  let resolveConnected;
  const connected = new Promise((resolve) => {
    resolveConnected = resolve;
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/pi/open") {
      json(response, openResponse);
      return;
    }
    if (url.pathname === "/api/v1/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });
      response.write("retry: 1000\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      if (streams.size === 2) {
        resolveConnected();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cliClient = new HttpHostClient({ baseUrl });
  const webClient = new HttpHostClient({ baseUrl });
  const command = { cwd: "/workspace", sessionId: SESSION_ID };
  const subscriptions = [];

  try {
    const [cliSnapshot, webSnapshot] = await Promise.all([
      cliClient.openSession(command),
      webClient.openSession(command),
    ]);
    assert.equal(cliSnapshot.sessionId, webSnapshot.sessionId);

    const cliEvent = new Promise((resolve) => {
      subscriptions.push(cliClient.subscribeSession(SESSION_ID, 0, resolve));
    });
    const webEvent = new Promise((resolve) => {
      subscriptions.push(webClient.subscribeSession(SESSION_ID, 0, resolve));
    });
    await connected;

    const envelope = {
      id: "event-1",
      payload: { delta: "hello", type: "text_delta" },
      sequence: 1,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      type: "message_update",
    };
    for (const stream of streams) {
      stream.write(
        `id: 1\nevent: message\ndata: ${JSON.stringify(envelope)}\n\n`
      );
    }

    const [receivedByCli, receivedByWeb] = await Promise.all([
      cliEvent,
      webEvent,
    ]);
    assert.deepEqual(receivedByCli, envelope);
    assert.deepEqual(receivedByWeb, envelope);
  } finally {
    for (const subscription of subscriptions) {
      subscription.close();
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
