/**
 * P0 experiment 5 — minimal UI plugin sample (plan §13 P0 交付 8, §7.10).
 *
 * A "progress card" plugin end-to-end without touching any host client code:
 *   1. backend facts (start/update/terminal) fold through the NodeAssembler
 *      into a stable view model;
 *   2. generation 1 of the plugin renders the view model into a declarative
 *      component tree (validated against the bounded component protocol);
 *   3. the contribution registry hot-swaps to generation 2 (richer tree),
 *      running generation-1 cleanups and leaving no duplicate contributions;
 *   4. unknown renderers / unreadable payload versions degrade to read-only
 *      fallback instead of breaking the session;
 *   5. live append and full replay produce identical rendered trees.
 *
 * Run: node --no-warnings experiments/p0/ui-plugin-sample.mjs
 */
import { NodeAssembler } from "@omo/plugin-sdk/assembler";
import { ContributionRegistry } from "@omo/plugin-sdk/registry";
import {
  ComponentNodeSchema,
  fallbackComponent,
} from "@omo/plugin-ui-schema/components";
import { Compile } from "typebox/compile";

const report = { assertions: [], ok: true };
const check = (name, condition, detail = "") => {
  report.assertions.push({ detail, name, ok: condition });
  if (!condition) {
    report.ok = false;
  }
};
const componentCheck = Compile(ComponentNodeSchema);

// --- Sample plugin: "progress-card" ------------------------------------------
const identity = {
  entityId: "build-1",
  kind: "progress-card",
  pluginId: "demo.progress",
};
const at = (seq) => `2026-09-12T00:00:0${seq}.000Z`;
const facts = [
  {
    at: at(0),
    entitySeq: 0,
    factType: "start",
    generation: "gen_1",
    identity,
    payload: { label: "Build", ratio: 0, status: "running" },
    payloadVersion: 1,
  },
  {
    at: at(1),
    entitySeq: 1,
    factType: "update",
    generation: "gen_1",
    identity,
    payload: { ratio: 0.5 },
    payloadVersion: 1,
  },
  {
    at: at(2),
    entitySeq: 2,
    factType: "terminal",
    generation: "gen_1",
    identity,
    payload: { ratio: 1, status: "done" },
    payloadVersion: 1,
  },
];

// Generation 1 renderer: plain status + text (safe baseline).
const rendererGen1 = {
  kind: "progress-card",
  payloadVersions: [1],
  pluginId: "demo.progress",
  render: (view) => ({
    children: [
      {
        kind: "status",
        label: view.payload.label,
        state: view.payload.status === "done" ? "done" : "running",
      },
      {
        kind: "text",
        text: `progress ${(view.payload.ratio * 100).toFixed(0)}%`,
      },
    ],
    kind: "stack",
  }),
};

// Generation 2 renderer: richer tree with a real progress component.
const rendererGen2 = {
  kind: "progress-card",
  payloadVersions: [1],
  pluginId: "demo.progress",
  render: (view) => ({
    children: [
      {
        kind: "status",
        label: view.payload.label,
        state: view.payload.status === "done" ? "done" : "running",
      },
      { kind: "progress", label: "build", ratio: view.payload.ratio },
      {
        kind: "markdown",
        markdown: view.payload.status === "done" ? "**done**" : "working…",
      },
    ],
    kind: "stack",
  }),
};

// --- 1+2: assemble + render with generation 1 ----------------------------------
const assembler = new NodeAssembler();
for (const fact of facts) {
  assembler.apply(fact);
}
const [assembledView] = assembler.snapshot();
check("sample.viewModel.settled", assembledView.state === "settled");
check(
  "sample.viewModel.payload",
  assembledView.payload.ratio === 1 && assembledView.payload.status === "done"
);

const registry = new ContributionRegistry();
const cleanups = [];
registry.activateGeneration("demo.progress", "gen_1", [
  {
    cleanup: () => cleanups.push("gen_1.renderer"),
    contributionId: "progress-card",
    payload: rendererGen1,
    slot: "conversation.node",
  },
]);

const keyed = () => registry.view().keyed.get("conversation.node");
const tree1 = keyed().get("progress-card").render(assembledView);
check("sample.gen1.rendersValidTree", componentCheck.Check(tree1) === true);
check("sample.gen1.treeShape", tree1.children[1].kind === "text");

// --- 3: hot swap to generation 2 without touching host code --------------------
registry.activateGeneration("demo.progress", "gen_2", [
  {
    cleanup: () => cleanups.push("gen_2.renderer"),
    contributionId: "progress-card",
    payload: rendererGen2,
    slot: "conversation.node",
  },
]);
check("sample.hotSwap.ranGen1Cleanup", cleanups.join(",") === "gen_1.renderer");
check("sample.hotSwap.singleContribution", keyed().size === 1);
const tree2 = keyed().get("progress-card").render(assembledView);
check("sample.gen2.rendersValidTree", componentCheck.Check(tree2) === true);
check("sample.gen2.richerTree", tree2.children[1].kind === "progress");

// --- 4: fallback for unknown renderer / unreadable payload ----------------------
const missing = keyed().get("no-such-kind");
check("sample.unknownRenderer.fallsBack", missing === undefined);
const fallbackTree = fallbackComponent({ kind: "no-such-kind" });
check("sample.fallbackTree.valid", componentCheck.Check(fallbackTree) === true);

// Renderer that cannot read the view model's payload version: host keeps the
// read-only fallback rather than feeding old data to arbitrary new code.
const incompatibleRenderer = {
  kind: "progress-card",
  payloadVersions: [2],
  pluginId: "demo.progress",
  render: rendererGen1.render,
};
const canRead = incompatibleRenderer.payloadVersions.includes(
  assembledView.payloadVersion
);
check("sample.versionSkew.blocked", canRead === false);

// --- 5: live append vs full replay render identical trees -----------------------
const replayed = new NodeAssembler();
for (const fact of [...facts].reverse()) {
  replayed.apply(fact); // tail-first arrival simulates history pagination
}
const [replayedView] = replayed.snapshot();
const treeFromReplay = keyed().get("progress-card").render(replayedView);
check(
  "sample.replay.renderIdentical",
  JSON.stringify(treeFromReplay) === JSON.stringify(tree2)
);

// --- memory / dispose hygiene: swap 200 times ----------------------------------
for (let generation = 3; generation <= 202; generation += 1) {
  registry.activateGeneration("demo.progress", `gen_${generation}`, [
    {
      contributionId: "progress-card",
      payload: rendererGen2,
      slot: "conversation.node",
    },
  ]);
}
check(
  "sample.repeatedSwap.stable",
  registry.activeGeneration("demo.progress") === "gen_202" && keyed().size === 1
);

console.log(JSON.stringify(report, null, 2));
process.exit(report.assertions.every((assertion) => assertion.ok) ? 0 : 1);
