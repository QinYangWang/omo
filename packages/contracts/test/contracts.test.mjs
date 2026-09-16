import assert from "node:assert/strict";
import test from "node:test";
import {
  AcceptedOperationSchema,
  AgentEventEnvelopeSchema,
  ContractValidationError,
  HostApiContracts,
  HostHealthSchema,
  JsonValueSchema,
  OpenSessionResponseSchema,
  ProjectListSchema,
  PromptCommandSchema,
  parseContract,
  SessionListSchema,
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

test("Project and Session list contracts match current HTTP responses", () => {
  assert.deepEqual(
    parseContract(
      ProjectListSchema,
      [{ cwd: "/workspace/project", id: "project-1", name: "project" }],
      "ProjectList"
    ),
    [{ cwd: "/workspace/project", id: "project-1", name: "project" }]
  );
  const sessions = parseContract(
    SessionListSchema,
    [
      {
        allMessagesText: "hello",
        created: 1,
        cwd: "/workspace/project",
        firstMessage: "hello",
        id: "session-1",
        messageCount: 2,
        modified: 2,
        path: "/sessions/session-1.jsonl",
      },
    ],
    "SessionList"
  );
  assert.equal(sessions[0]?.messageCount, 2);
});

test("Session open and Prompt acceptance contracts match current responses", () => {
  const opened = parseContract(
    OpenSessionResponseSchema,
    {
      contextUsage: { contextWindow: 200_000, percent: 1, tokens: 2000 },
      cursor: 0,
      eventSequence: 3,
      hasMore: false,
      isStreaming: true,
      messages: [{ id: "message-1", role: "user", text: "hello" }],
      model: { id: "model-1", name: "Model", provider: "provider" },
      outline: [{ absoluteIndex: 0, id: "message-1", userPreview: "hello" }],
      replayFromSequence: 2,
      sessionFile: "/sessions/session-1.jsonl",
      sessionId: "session-1",
      thinkingLevel: "medium",
    },
    "OpenSessionResponse"
  );
  assert.equal(opened.eventSequence, 3);

  const accepted = parseContract(
    AcceptedOperationSchema,
    {
      operationId: "operation-1",
      sessionFile: "/sessions/session-1.jsonl",
      sessionId: "session-1",
    },
    "AcceptedOperation"
  );
  assert.equal(accepted.operationId, "operation-1");
  assert.equal(HostApiContracts.prompt.response, AcceptedOperationSchema);
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
