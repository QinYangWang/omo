import assert from "node:assert/strict";
import test from "node:test";
import type { NodeFact } from "@omo/plugin-ui-schema/nodes";
import { NodeAssembler } from "../src/assembler.ts";

/**
 * Replay consistency (plan §7.0, §7.6): live append, history prepend and
 * full replay of the same durable facts must produce the same final view
 * models. Settlement replaces streamed payload; tails stay pending until
 * their start arrives.
 */

const identity = {
  entityId: "task-1",
  kind: "progress-card",
  pluginId: "demo",
};

const fact = (
  factType: NodeFact["factType"],
  entitySeq: number,
  payload: unknown,
  at = `2026-09-12T00:00:${String(entitySeq).padStart(2, "0")}.000Z`
): NodeFact => ({
  at,
  entitySeq,
  factType,
  generation: "gen_1",
  identity,
  payload,
  payloadVersion: 1,
});

const LIVE_ORDER = [
  fact("start", 0, { status: "running", text: "" }),
  fact("update", 1, { text: "downloading" }),
  fact("update", 2, { progress: 0.5, text: "half way" }),
  fact("terminal", 3, { progress: 1, status: "done", text: "finished" }),
];

test("live append folds to a settled view model", () => {
  const assembler = new NodeAssembler();
  for (const f of LIVE_ORDER) {
    assembler.apply(f);
  }
  const [view] = assembler.snapshot();
  assert.equal(view.state, "settled");
  assert.deepEqual(view.payload, {
    progress: 1,
    status: "done",
    text: "finished",
  });
  assert.equal(view.appliedFacts, 4);
  assert.equal(view.lastEntitySeq, 3);
});

test("history prepend (tail first, start last) yields the same view model", () => {
  // Pagination delivers the newest page first: terminal + last update arrive
  // before the page containing the start fact.
  const assembler = new NodeAssembler();
  for (const f of [
    LIVE_ORDER[3],
    LIVE_ORDER[2],
    LIVE_ORDER[1],
    LIVE_ORDER[0],
  ]) {
    assembler.apply(f);
  }
  const live = new NodeAssembler();
  for (const f of LIVE_ORDER) {
    live.apply(f);
  }
  assert.deepEqual(assembler.snapshot(), live.snapshot());
});

test("full replay after restart matches the pre-restart snapshot", () => {
  const before = new NodeAssembler();
  for (const f of LIVE_ORDER) {
    before.apply(f);
  }
  const replayed = new NodeAssembler();
  for (const f of LIVE_ORDER) {
    replayed.apply(f);
  }
  assert.deepEqual(replayed.snapshot(), before.snapshot());
});

test("tail facts before start keep the entity pending until start arrives", () => {
  const assembler = new NodeAssembler();
  const pendingView = assembler.apply(fact("update", 1, { text: "tail" }));
  assert.equal(pendingView.state, "pending");
  assert.equal(pendingView.payload, undefined);

  const after = assembler.apply(
    fact("start", 0, { status: "running", text: "" })
  );
  assert.equal(after.state, "open");
  assert.deepEqual(after.payload, { status: "running", text: "tail" });
});

test("duplicate facts are idempotent", () => {
  const assembler = new NodeAssembler();
  assembler.apply(LIVE_ORDER[0]);
  assembler.apply(LIVE_ORDER[1]);
  assembler.apply(LIVE_ORDER[1]); // redelivered
  assembler.apply(LIVE_ORDER[1]); // redelivered
  const [view] = assembler.snapshot();
  assert.equal(view.appliedFacts, 2);
  assert.equal(view.lastEntitySeq, 1);
});

test("terminal settlement REPLACES streamed string payloads (no concatenation)", () => {
  const assembler = new NodeAssembler();
  assembler.apply(fact("start", 0, "stream:"));
  assembler.apply(fact("update", 1, "stream:partial text"));
  const settled = assembler.apply(fact("terminal", 2, "final text"));
  assert.equal(settled.payload, "final text");
  assert.equal(settled.state, "settled");
});

test("multiple entities fold independently and snapshot order is canonical", () => {
  const assembler = new NodeAssembler();
  const other = { ...identity, entityId: "task-2" };
  // Interleave entities and arrival order.
  assembler.apply({ ...fact("update", 1, { n: 1 }), identity: other });
  assembler.apply(fact("start", 0, { n: 0 }));
  assembler.apply({ ...fact("start", 0, { n: 0 }), identity: other });
  assembler.apply(fact("update", 1, { n: 1 }));
  const snapshot = assembler.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].identity.entityId, "task-1");
  assert.equal(snapshot[1].identity.entityId, "task-2");
  assert.deepEqual(snapshot[0].payload, { n: 1 });
  assert.deepEqual(snapshot[1].payload, { n: 1 });
});
