import assert from "node:assert/strict";
import test from "node:test";
import {
  HostConnection,
  HostRegistry,
  SessionAttachmentState,
} from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const OTHER_HOST_ID = "b72a65cd-c91a-4517-9d3e-638921632485";
const ALREADY_REGISTERED_PATTERN = /already registered/;
const health = (hostId = HOST_ID) => ({
  capabilities: ["events"],
  hostId,
  ok: true,
  protocolVersion: 1,
  version: 1,
});

test("Host registry normalizes endpoints and persists logical identity", async () => {
  let stored = [];
  const registry = new HostRegistry(
    {
      load: async () => stored,
      save: (hosts) => {
        stored = [...hosts];
        return Promise.resolve();
      },
    },
    () => "registration-1"
  );
  await registry.initialize();

  const first = await registry.register({ url: "https://host.example///" });
  const duplicate = await registry.register({
    label: "Duplicate",
    url: "https://host.example",
  });
  const identified = await registry.confirmIdentity(first.registryId, health());

  assert.equal(first, duplicate);
  assert.equal(identified.hostId, HOST_ID);
  assert.equal(registry.findByHostId(HOST_ID)?.url, "https://host.example");
  assert.deepEqual(stored, [identified]);
});

test("Host registry prevents two entries from claiming one Host identity", async () => {
  let stored = [];
  let nextId = 0;
  const registry = new HostRegistry(
    {
      load: async () => stored,
      save: (hosts) => {
        stored = [...hosts];
        return Promise.resolve();
      },
    },
    () => {
      nextId += 1;
      return `registration-${nextId}`;
    }
  );
  await registry.initialize();
  const first = await registry.register({ url: "https://one.example" });
  const second = await registry.register({ url: "https://two.example" });
  await registry.confirmIdentity(first.registryId, health());
  await assert.rejects(
    registry.confirmIdentity(second.registryId, health()),
    ALREADY_REGISTERED_PATTERN
  );
});

test("Host connection ignores a stale probe result after disconnect", async () => {
  let resolveProbe;
  const connection = new HostConnection(
    {
      label: "Host",
      registryId: "registration-1",
      url: "https://host.example",
    },
    {
      health: () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    }
  );

  const connecting = connection.connect();
  connection.disconnect();
  resolveProbe(health(OTHER_HOST_ID));
  await connecting;

  assert.deepEqual(connection.status, { state: "idle" });
});

test("Session attachment deduplicates events and detects sequence gaps", () => {
  const attachment = new SessionAttachmentState("session-1");
  attachment.connecting();
  attachment.connected();
  const event = (sequence) => ({
    id: `event-${sequence}`,
    payload: { type: "message_update" },
    sequence,
    sessionId: "session-1",
    timestamp: sequence,
    type: "message_update",
  });

  assert.equal(attachment.accept(event(1)), "accepted");
  assert.equal(attachment.accept(event(1)), "duplicate");
  assert.equal(attachment.accept(event(3)), "gap");
  assert.equal(attachment.status, "snapshot-required");
  attachment.hydrate(3);
  assert.equal(attachment.accept(event(4)), "accepted");
  assert.equal(attachment.afterSequence, 4);
});
