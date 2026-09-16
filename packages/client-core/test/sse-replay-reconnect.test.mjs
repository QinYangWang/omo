import assert from "node:assert/strict";
import test from "node:test";
import { HttpHostClient } from "../dist/index.js";

const SSE_ROUTE = "/api/v1/events";
const textEncoder = new TextEncoder();

const envelope = (sequence, delta) => ({
  id: `event-${sequence}`,
  payload: { delta },
  sequence,
  sessionId: "session-1",
  timestamp: sequence,
  type: "text_delta",
});

const sseBlock = (event) =>
  `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;

// A stream that stays open so connections after the fixture never end, and
// that closes when the client aborts the subscription.
const openStream = (signal) =>
  new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.close());
    },
  });

// First connection delivers an event then drops; the reconnect must resume
// from the last delivered sequence, and replayed duplicates must be
// suppressed exactly once in order.
test("HTTP Host client suppresses SSE duplicates across abrupt disconnects", async () => {
  const urls = [];
  const received = [];
  let connectionCount = 0;

  const fetch = (input, init) => {
    const { pathname } = new URL(String(input));
    urls.push(String(input));
    if (pathname !== SSE_ROUTE) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "unexpected route" }), {
          status: 404,
        })
      );
    }
    connectionCount += 1;
    const headers = { "Content-Type": "text/event-stream" };
    if (connectionCount === 1) {
      // Deliver event 6, then drop the connection abruptly.
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new Error("connection lost"));
        },
        start(controller) {
          controller.enqueue(
            textEncoder.encode(sseBlock(envelope(6, "hello")))
          );
        },
      });
      return Promise.resolve(new Response(body, { headers, status: 200 }));
    }
    if (connectionCount === 2) {
      // Reconnect replays the last event (duplicate of 6) plus the next
      // event (7) in a single flush.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            textEncoder.encode(
              sseBlock(envelope(6, "hello")) + sseBlock(envelope(7, "world"))
            )
          );
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { headers, status: 200 }));
    }
    return Promise.resolve(
      new Response(openStream(init?.signal), { headers, status: 200 })
    );
  };

  const client = new HttpHostClient({
    baseUrl: "https://host.example",
    fetch,
    reconnectDelayMs: 1,
  });

  const done = Promise.withResolvers();
  const subscription = client.subscribeSession("session-1", 5, (event) => {
    received.push(event.sequence);
    if (received.length === 2) {
      done.resolve();
    }
  });
  await done.promise;
  subscription.close();

  // Replayed duplicate 6 is suppressed, event 7 is delivered once.
  assert.deepEqual(received, [6, 7]);
  assert.equal(
    urls[0],
    "https://host.example/api/v1/events?after=5&sessionId=session-1"
  );
  // Reconnect resumes from the last delivered sequence, not the initial one.
  assert.equal(
    urls[1],
    "https://host.example/api/v1/events?after=6&sessionId=session-1"
  );
});
