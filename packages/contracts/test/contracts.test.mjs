import assert from "node:assert/strict";
import test from "node:test";
import {
  AcceptedOperationSchema,
  AgentEventEnvelopeSchema,
  ContractValidationError,
  EXTENSION_EVENT_BATCH_MAX_ITEMS,
  ExtensionAckSchema,
  ExtensionChannelContracts,
  ExtensionCommandSchema,
  ExtensionEventBatchSchema,
  ExtensionRegisterRequestSchema,
  HostApiContracts,
  HostHealthSchema,
  HostRegistryDocumentSchema,
  HostRegistryEntrySchema,
  JsonValueSchema,
  OpenSessionResponseSchema,
  ProjectListSchema,
  PromptCommandSchema,
  parseContract,
  SessionExecutionStateSchema,
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

test("OpenSessionResponse exposes an optional credential-free execution view", () => {
  const base = {
    contextUsage: null,
    cursor: 0,
    eventSequence: 0,
    hasMore: false,
    isStreaming: false,
    messages: [],
    model: null,
    sessionId: "session-1",
    thinkingLevel: "off",
  };
  // Backward compatible: older responses that predate E4-001 still validate.
  assert.equal(
    parseContract(OpenSessionResponseSchema, base, "OpenSessionResponse")
      .execution,
    undefined
  );
  for (const execution of [
    { state: "detached" },
    { state: "headless-owned" },
    { generation: 2, ownerInstanceId: HOST_ID, state: "native-attached" },
  ]) {
    assert.deepEqual(
      parseContract(
        OpenSessionResponseSchema,
        { ...base, execution },
        "OpenSessionResponse"
      ).execution,
      execution
    );
  }
  assert.throws(
    () =>
      parseContract(
        OpenSessionResponseSchema,
        { ...base, execution: { state: "attaching" } },
        "OpenSessionResponse"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        OpenSessionResponseSchema,
        { ...base, execution: { credential: "secret", state: "detached" } },
        "OpenSessionResponse"
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

const INSTANCE_ID = "3f6b1c2e-7c3a-4d5e-9f0a-1b2c3d4e5f6a";

test("Extension register pins the channel version and instance identity", () => {
  const request = {
    capabilities: ["events", "commands"],
    channelVersion: 1,
    extensionVersion: "0.1.0",
    instanceId: INSTANCE_ID,
    piVersion: "0.85.0",
    sessionId: "session-1",
  };
  const parsed = parseContract(
    ExtensionRegisterRequestSchema,
    request,
    "ExtensionRegisterRequest"
  );
  assert.equal(parsed.instanceId, INSTANCE_ID);
  assert.throws(
    () =>
      parseContract(
        ExtensionRegisterRequestSchema,
        { ...request, channelVersion: 2 },
        "ExtensionRegisterRequest"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        ExtensionRegisterRequestSchema,
        { ...request, instanceId: "not-a-uuid" },
        "ExtensionRegisterRequest"
      ),
    ContractValidationError
  );
  // Credentials never appear in the register body: they are only ever
  // returned by the daemon and transported as an Authorization header.
  assert.throws(
    () =>
      parseContract(
        ExtensionRegisterRequestSchema,
        { ...request, credential: "secret" },
        "ExtensionRegisterRequest"
      ),
    ContractValidationError
  );
});

test("Extension event batches require generation scope and bounded size", () => {
  const event = {
    event: "message_update",
    nativeSequence: 1,
    payload: { delta: "he" },
    sessionId: "session-1",
    timestamp: Date.now(),
  };
  const batch = { events: [event], generation: 3, instanceId: INSTANCE_ID };
  const parsed = parseContract(
    ExtensionEventBatchSchema,
    batch,
    "ExtensionEventBatch"
  );
  assert.equal(parsed.events[0].nativeSequence, 1);
  assert.throws(
    () =>
      parseContract(
        ExtensionEventBatchSchema,
        { ...batch, generation: 0 },
        "ExtensionEventBatch"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        ExtensionEventBatchSchema,
        { ...batch, events: [{ ...event, nativeSequence: 0 }] },
        "ExtensionEventBatch"
      ),
    ContractValidationError
  );
  const oversized = {
    ...batch,
    events: Array.from({ length: EXTENSION_EVENT_BATCH_MAX_ITEMS + 1 }, () => ({
      ...event,
    })),
  };
  assert.throws(
    () =>
      parseContract(
        ExtensionEventBatchSchema,
        oversized,
        "ExtensionEventBatch"
      ),
    ContractValidationError
  );
});

test("Extension commands are a closed union and prompts require text", () => {
  const prompt = {
    commandSequence: 7,
    requestId: "req-1",
    text: "Continue",
    type: "prompt",
  };
  assert.equal(
    parseContract(ExtensionCommandSchema, prompt, "ExtensionCommand").type,
    "prompt"
  );
  const abort = { commandSequence: 8, requestId: "req-2", type: "abort" };
  assert.equal(
    parseContract(ExtensionCommandSchema, abort, "ExtensionCommand").type,
    "abort"
  );
  assert.throws(
    () =>
      parseContract(
        ExtensionCommandSchema,
        { commandSequence: 9, requestId: "req-3", type: "prompt" },
        "ExtensionCommand"
      ),
    ContractValidationError
  );
  assert.throws(
    () =>
      parseContract(
        ExtensionCommandSchema,
        { ...abort, type: "eval" },
        "ExtensionCommand"
      ),
    ContractValidationError
  );
});

test("Extension acks carry the fenced status set and echo correlation ids", () => {
  const ack = {
    commandSequence: 7,
    generation: 3,
    instanceId: INSTANCE_ID,
    requestId: "req-1",
    status: "completed",
  };
  for (const status of ["accepted", "started", "rejected", "completed"]) {
    assert.equal(
      parseContract(ExtensionAckSchema, { ...ack, status }, "ExtensionAck")
        .status,
      status
    );
  }
  assert.throws(
    () =>
      parseContract(
        ExtensionAckSchema,
        { ...ack, status: "unknown" },
        "ExtensionAck"
      ),
    ContractValidationError
  );
});

test("Session execution state is a closed three-state owner view", () => {
  for (const state of ["headless-owned", "native-attached", "detached"]) {
    assert.equal(
      parseContract(
        SessionExecutionStateSchema,
        { state },
        "SessionExecutionState"
      ).state,
      state
    );
  }
  assert.throws(
    () =>
      parseContract(
        SessionExecutionStateSchema,
        { state: "attaching" },
        "SessionExecutionState"
      ),
    ContractValidationError
  );
});

test("Extension channel endpoints stay on the private namespace", () => {
  const paths = Object.values(ExtensionChannelContracts).map(
    (contract) => contract.path
  );
  assert.deepEqual(paths.sort(), [
    "/api/v1/extension/ack",
    "/api/v1/extension/commands",
    "/api/v1/extension/detach",
    "/api/v1/extension/events",
    "/api/v1/extension/heartbeat",
    "/api/v1/extension/register",
  ]);
});
