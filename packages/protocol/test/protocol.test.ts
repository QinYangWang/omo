import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import {
  buildCommandEnvelope,
  CommandEnvelopeSchema,
  CommandReceiptSchema,
  hashCommandPayload,
} from "../src/command.ts";
import { compareCursors, FrameSchema, incrementCursor } from "../src/frame.ts";
import { newCommandId } from "../src/ids.ts";
import { OMO_PROTOCOL_VERSION } from "../src/version.ts";

const envelopeCheck = Compile(CommandEnvelopeSchema);
const receiptCheck = Compile(CommandReceiptSchema);
const frameCheck = Compile(FrameSchema);

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));

test("golden command envelope fixture validates and keeps a stable hash", () => {
  const fixture = readFixture("command-envelope.json") as Record<
    string,
    unknown
  >;
  assert.equal(envelopeCheck.Check(fixture), true);
  assert.equal(
    fixture.payloadHash,
    hashCommandPayload(fixture.payload),
    "payload hash must be reproducible across processes"
  );
});

test("golden frame fixture validates", () => {
  const fixture = readFixture("frame.json");
  assert.equal(frameCheck.Check(fixture), true);
});

test("golden receipt fixture validates", () => {
  const fixture = readFixture("command-receipt.json");
  assert.equal(receiptCheck.Check(fixture), true);
});

const COMMAND_ID_PATTERN = /^cmd_[0-9a-f-]{36}$/;

test("envelope builder fills protocol version and payload hash", () => {
  const commandId = newCommandId();
  const envelope = buildCommandEnvelope({
    clientMutationId: "mut-1",
    commandId,
    kind: "session.prompt",
    payload: { text: "hello" },
    scope: { laneId: "main", sessionId: "ses_1", workspaceId: "wks_1" },
  });
  assert.equal(envelope.protocolVersion, OMO_PROTOCOL_VERSION);
  assert.match(envelope.commandId, COMMAND_ID_PATTERN);
  assert.equal(envelopeCheck.Check(envelope), true);
});

test("payload hash is canonical-key-order independent", () => {
  const a = hashCommandPayload({ a: { d: [1, { c: true }], e: "x" }, b: 2 });
  const b = hashCommandPayload({ a: { d: [1, { c: true }], e: "x" }, b: 2 });
  assert.equal(a, b);
});

test("payload hash differs for different payloads", () => {
  assert.notEqual(hashCommandPayload({ a: 1 }), hashCommandPayload({ a: 2 }));
});

test("payloads containing BigInt are rejected (plan §6.3)", () => {
  assert.throws(() => hashCommandPayload({ seq: 1n }), TypeError);
});

test("envelope rejects malformed wire data", () => {
  assert.equal(envelopeCheck.Check({}), false);
  assert.equal(
    envelopeCheck.Check({
      clientMutationId: "m",
      commandId: "cmd_x",
      issuedAt: "yesterday",
      kind: "k",
      payload: {},
      payloadHash: "not-a-sha",
      protocolVersion: OMO_PROTOCOL_VERSION,
      schemaVersion: 1,
      scope: { workspaceId: "w" },
    }),
    false
  );
});

test("decimal-string cursors compare and increment without number precision", () => {
  assert.equal(incrementCursor("9007199254740993"), "9007199254740994");
  assert.equal(compareCursors("2", "10"), -1);
  assert.equal(compareCursors("10", "2"), 1);
  assert.equal(compareCursors("7", "7"), 0);
});
