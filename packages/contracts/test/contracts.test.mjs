import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventEnvelopeSchema,
  ContractValidationError,
  HostHealthSchema,
  JsonValueSchema,
  PromptCommandSchema,
  parseContract,
} from "../dist/index.js";

const HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";

test("Host health requires a durable logical identity", () => {
  const health = parseContract(
    HostHealthSchema,
    {
      capabilities: ["pi", "events"],
      hostId: HOST_ID,
      ok: true,
      protocolVersion: 1,
      version: 1,
    },
    "HostHealth"
  );
  assert.equal(health.hostId, HOST_ID);
  assert.throws(
    () =>
      parseContract(
        HostHealthSchema,
        {
          capabilities: [],
          hostId: "not-a-host-id",
          ok: true,
          protocolVersion: 1,
          version: 1,
        },
        "HostHealth"
      ),
    ContractValidationError
  );
});

test("Prompt commands reject empty messages and unknown properties", () => {
  const valid = {
    cwd: "/workspace/project",
    message: "Continue",
    requestId: "operation-1",
    sessionId: "session-1",
  };
  assert.equal(
    parseContract(PromptCommandSchema, valid, "PromptCommand").message,
    "Continue"
  );
  assert.throws(
    () =>
      parseContract(
        PromptCommandSchema,
        { ...valid, message: "" },
        "PromptCommand"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        PromptCommandSchema,
        { ...valid, unexpected: true },
        "PromptCommand"
      ),
    ContractValidationError
  );
});

test("JSON and Agent event contracts reject non-JSON values", () => {
  assert.deepEqual(
    parseContract(JsonValueSchema, { delta: ["hello", 1, null] }, "JsonValue"),
    { delta: ["hello", 1, null] }
  );
  assert.throws(
    () => parseContract(JsonValueSchema, { delta: undefined }, "JsonValue"),
    ContractValidationError
  );
  assert.throws(
    () => parseContract(JsonValueSchema, Number.POSITIVE_INFINITY, "JsonValue"),
    ContractValidationError
  );

  const event = parseContract(
    AgentEventEnvelopeSchema,
    {
      id: "event-1",
      payload: { delta: "hello", type: "text_delta" },
      sequence: 1,
      sessionId: "session-1",
      timestamp: 1,
      type: "message_update",
    },
    "AgentEventEnvelope"
  );
  assert.equal(event.sequence, 1);
});
