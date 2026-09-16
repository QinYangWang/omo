import assert from "node:assert/strict";
import test from "node:test";
import {
  AcceptedOperationSchema,
  AgentEventEnvelopeSchema,
  ContractValidationError,
  HostApiContracts,
  HostHealthSchema,
  HostRegistryDocumentSchema,
  HostRegistryEntrySchema,
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
      {
        created: 1,
        cwd: "/workspace/project",
        firstMessage: "legacy runtime summary",
        id: "session-2",
        modified: 2,
        path: "/sessions/session-2.jsonl",
      },
    ],
    "SessionList"
  );
  assert.equal(sessions[0]?.messageCount, 2);
  assert.equal(sessions[1]?.messageCount, undefined);
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

test("Host registry entries accept URL and local endpoints", () => {
  const urlEntry = {
    credentialRef: "keychain:omo/team",
    endpoint: { transport: "https", url: "https://host.example:5189" },
    expectedHostId: HOST_ID,
    id: "entry-1",
    label: "Team Host",
  };
  assert.deepEqual(
    parseContract(HostRegistryEntrySchema, urlEntry, "HostRegistryEntry"),
    urlEntry
  );
  for (const endpoint of [
    { path: "/run/omo.sock", transport: "unix" },
    { path: "\\\\.\\pipe\\omo-abc", transport: "pipe" },
  ]) {
    const parsed = parseContract(
      HostRegistryEntrySchema,
      { endpoint, id: "entry-local", label: "Local daemon" },
      "HostRegistryEntry"
    );
    assert.deepEqual(parsed.endpoint, endpoint);
  }
});

test("Host registry rejects malformed or unknown transports", () => {
  const base = { id: "entry-1", label: "Host" };
  for (const endpoint of [
    { transport: "tcp", url: "http://127.0.0.1:5189" },
    { transport: "ftp", url: "ftp://host.example" },
    { transport: "unix" },
    { transport: "pipe" },
    { path: "", transport: "unix" },
    { transport: "http" },
  ]) {
    assert.throws(
      () =>
        parseContract(
          HostRegistryEntrySchema,
          { ...base, endpoint },
          "HostRegistryEntry"
        ),
      ContractValidationError
    );
  }
});

test("Host registry rejects credential material and unknown fields", () => {
  const entry = {
    endpoint: { transport: "http", url: "http://127.0.0.1:5189" },
    id: "entry-1",
    label: "Host",
  };
  for (const leaked of ["token", "bearerToken", "secret", "password"]) {
    assert.throws(
      () =>
        parseContract(
          HostRegistryEntrySchema,
          { ...entry, [leaked]: "credential-material" },
          "HostRegistryEntry"
        ),
      ContractValidationError
    );
  }
  const withRef = { ...entry, credentialRef: "keychain:omo/team" };
  assert.equal(
    parseContract(HostRegistryEntrySchema, withRef, "HostRegistryEntry")
      .credentialRef,
    "keychain:omo/team"
  );
});

test("Host registry entry id and expected Host identity are independent fields", () => {
  const entry = {
    endpoint: { transport: "https", url: "https://host.example" },
    expectedHostId: HOST_ID,
    id: HOST_ID,
    label: "Host",
  };
  const parsed = parseContract(
    HostRegistryEntrySchema,
    entry,
    "HostRegistryEntry"
  );
  assert.equal(parsed.id, HOST_ID);
  assert.equal(parsed.expectedHostId, HOST_ID);
  assert.throws(
    () =>
      parseContract(
        HostRegistryEntrySchema,
        { ...entry, expectedHostId: "not-a-host-id" },
        "HostRegistryEntry"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        HostRegistryEntrySchema,
        { ...entry, id: "" },
        "HostRegistryEntry"
      ),
    ContractValidationError
  );
});

test("Host registry documents are explicitly versioned and reject unknown fields", () => {
  const document = {
    entries: [
      {
        endpoint: { transport: "http", url: "http://127.0.0.1:5189" },
        id: "entry-1",
        label: "Local daemon",
      },
    ],
    schema: "omo.host-registry",
    selectedEntryId: "entry-1",
    version: 1,
  };
  assert.equal(
    parseContract(HostRegistryDocumentSchema, document, "HostRegistryDocument")
      .version,
    1
  );
  assert.throws(
    () =>
      parseContract(
        HostRegistryDocumentSchema,
        { ...document, version: 2 },
        "HostRegistryDocument"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        HostRegistryDocumentSchema,
        { ...document, extra: true },
        "HostRegistryDocument"
      ),
    ContractValidationError
  );
});
