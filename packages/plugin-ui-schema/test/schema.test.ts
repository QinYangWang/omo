import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { ComponentNodeSchema, fallbackComponent } from "../src/components.ts";
import { NodeFactSchema } from "../src/nodes.ts";

const componentCheck = Compile(ComponentNodeSchema);
const factCheck = Compile(NodeFactSchema);
const FALLBACK_KIND_PATTERN = /3d-chart/;

test("declarative component tree validates (bounded protocol, §7.6)", () => {
  const tree = {
    children: [
      { kind: "status", label: "Build", state: "running" },
      { kind: "progress", ratio: 0.5 },
      { kind: "markdown", markdown: "**half** way" },
    ],
    direction: "vertical",
    kind: "stack",
  };
  assert.equal(componentCheck.Check(tree), true);
});

test("unknown component kinds are rejected by the schema", () => {
  assert.equal(componentCheck.Check({ kind: "script", src: "x.js" }), false);
  assert.equal(componentCheck.Check({ kind: "iframe", src: "x" }), false);
});

test("fallback component is read-only text", () => {
  const fallback = fallbackComponent({ kind: "3d-chart" });
  assert.equal(fallback.kind, "text");
  assert.match(String(fallback.text), FALLBACK_KIND_PATTERN);
  assert.equal(componentCheck.Check(fallback), true);
});

test("node fact schema validates identity + sequence + generation", () => {
  const valid = {
    at: "2026-09-12T00:00:00.000Z",
    entitySeq: 0,
    factType: "start",
    generation: "gen_1",
    identity: { entityId: "e1", kind: "progress-card", pluginId: "demo" },
    payload: { text: "hi" },
    payloadVersion: 1,
  };
  assert.equal(factCheck.Check(valid), true);
  assert.equal(
    factCheck.Check({ ...valid, factType: "stream" }),
    false,
    "unknown fact types must be rejected"
  );
  assert.equal(
    factCheck.Check({ ...valid, identity: { ...valid.identity, kind: "" } }),
    false
  );
});
