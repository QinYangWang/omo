import assert from "node:assert/strict";
import test from "node:test";
import { HostRequestError, HttpHostClient } from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const textEncoder = new TextEncoder();

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });

test("HTTP Host client authenticates and validates commands and responses", async () => {
  const requests = [];
  const fetch = (input, init) => {
    requests.push({ init, url: String(input) });
    const { pathname } = new URL(String(input));
    if (pathname === "/api/v1/health") {
      return Promise.resolve(
        jsonResponse({
          capabilities: ["pi", "events"],
          hostId: HOST_ID,
          ok: true,
          protocolVersion: 1,
          version: 1,
        })
      );
    }
    if (pathname === "/api/v1/pi/prompt") {
      return Promise.resolve(
        jsonResponse({
          operationId: "operation-1",
          sessionFile: "/sessions/session-1.jsonl",
          sessionId: "session-1",
        })
      );
    }
    return Promise.resolve(jsonResponse({ error: "Unexpected route" }, 404));
  };
  const client = new HttpHostClient({
    baseUrl: "https://host.example/",
    fetch,
    token: "secret",
  });

  assert.equal((await client.health()).hostId, HOST_ID);
  const accepted = await client.prompt({
    cwd: "/workspace/project",
    message: "Continue",
    requestId: "operation-1",
    sessionId: "session-1",
  });

  assert.equal(accepted.operationId, "operation-1");
  assert.equal(requests[0]?.url, "https://host.example/api/v1/health");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.equal(requests[1]?.init?.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(requests[1]?.init?.body).requestId, "operation-1");
});

test("HTTP Host client invokes fetch with the browser global receiver", async () => {
  function browserFetch() {
    assert.equal(this, globalThis);
    return Promise.resolve(
      jsonResponse({
        capabilities: [],
        hostId: HOST_ID,
        ok: true,
        protocolVersion: 1,
        version: 1,
      })
    );
  }
  const client = new HttpHostClient({
    baseUrl: "https://host.example",
    fetch: browserFetch,
  });

  assert.equal((await client.health()).hostId, HOST_ID);
});

test("HTTP Host client surfaces structured Host errors", async () => {
  const client = new HttpHostClient({
    baseUrl: "https://host.example",
    fetch: async () => jsonResponse({ error: "Denied" }, 403),
  });

  await assert.rejects(
    client.listProjects(),
    (error) => error instanceof HostRequestError && error.status === 403
  );
});

test("HTTP Host client validates and resumes SSE events", async () => {
  const urls = [];
  const envelope = {
    id: "event-6",
    payload: { delta: "hello", type: "text_delta" },
    sequence: 6,
    sessionId: "session-1",
    timestamp: 1,
    type: "message_update",
  };
  const fetch = (input) => {
    urls.push(String(input));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          textEncoder.encode(
            `: heartbeat\n\nid: 6\ndata: ${JSON.stringify(envelope)}\n\n`
          )
        );
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
        status: 200,
      })
    );
  };
  const client = new HttpHostClient({
    baseUrl: "https://host.example",
    fetch,
    reconnectDelayMs: 1,
  });
  let subscription;
  const event = await new Promise((resolve) => {
    subscription = client.subscribeSession("session-1", 5, (received) => {
      subscription.close();
      resolve(received);
    });
  });

  assert.equal(event.sequence, 6);
  assert.equal(
    urls[0],
    "https://host.example/api/v1/events?after=5&sessionId=session-1"
  );
});
