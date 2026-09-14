import assert from "node:assert/strict";
import test from "node:test";
import { ContributionError, ContributionRegistry } from "../src/registry.ts";

/**
 * Contribution registry semantics (plan §7.4 B, §7.10): contributions are
 * host-owned data, generations swap atomically, activation errors never
 * corrupt the previous generation, cleanups always run on retirement.
 */

const rendererV1 = { render: (view: unknown) => view, version: 1 };
const rendererV2 = { render: (view: unknown) => view, version: 2 };

test("activate installs keyed and list contributions", () => {
  const registry = new ContributionRegistry();
  registry.activateGeneration("demo", "gen_1", [
    {
      contributionId: "progress-card",
      payload: rendererV1,
      slot: "conversation.node",
    },
    {
      contributionId: "open-panel",
      payload: { label: "Open panel" },
      slot: "conversation.header.actions",
    },
  ]);
  const view = registry.view();
  assert.equal(
    view.keyed.get("conversation.node")?.get("progress-card"),
    rendererV1
  );
  assert.deepEqual(view.lists.get("conversation.header.actions"), [
    { label: "Open panel" },
  ]);
  assert.equal(registry.activeGeneration("demo"), "gen_1");
});

test("unknown slot rejects the whole generation and keeps the previous one", () => {
  const registry = new ContributionRegistry();
  registry.activateGeneration("demo", "gen_1", [
    {
      contributionId: "progress-card",
      payload: rendererV1,
      slot: "conversation.node",
    },
  ]);
  assert.throws(
    () =>
      registry.activateGeneration("demo", "gen_2", [
        {
          contributionId: "x",
          payload: {},
          slot: "no.such.slot",
        },
      ]),
    (error: unknown) =>
      error instanceof ContributionError && error.code === "unknown_slot"
  );
  assert.equal(registry.activeGeneration("demo"), "gen_1");
  assert.equal(
    registry.view().keyed.get("conversation.node")?.get("progress-card"),
    rendererV1
  );
});

test("duplicate contribution ids within one generation are rejected", () => {
  const registry = new ContributionRegistry();
  assert.throws(
    () =>
      registry.activateGeneration("demo", "gen_1", [
        { contributionId: "a", payload: 1, slot: "workspace.panel" },
        { contributionId: "a", payload: 2, slot: "workspace.panel" },
      ]),
    (error: unknown) =>
      error instanceof ContributionError &&
      error.code === "duplicate_contribution"
  );
  assert.equal(registry.activeGeneration("demo"), undefined);
});

test("generation swap retires old contributions and runs cleanups", () => {
  const registry = new ContributionRegistry();
  const cleanups: string[] = [];
  registry.activateGeneration("demo", "gen_1", [
    {
      cleanup: () => cleanups.push("renderer-v1"),
      contributionId: "progress-card",
      payload: rendererV1,
      slot: "conversation.node",
    },
    {
      cleanup: () => cleanups.push("header-action-v1"),
      contributionId: "open-panel",
      payload: { label: "v1" },
      slot: "conversation.header.actions",
    },
  ]);
  registry.activateGeneration("demo", "gen_2", [
    {
      cleanup: () => cleanups.push("renderer-v2"),
      contributionId: "progress-card",
      payload: rendererV2,
      slot: "conversation.node",
    },
  ]);
  // Cleanups run in the registry's deterministic (sorted) install order.
  assert.deepEqual(cleanups, ["header-action-v1", "renderer-v1"]);
  const view = registry.view();
  assert.equal(
    view.keyed.get("conversation.node")?.get("progress-card"),
    rendererV2
  );
  // The retired header action must not linger (no duplicate buttons, §7.10).
  assert.deepEqual(view.lists.get("conversation.header.actions") ?? [], []);
});

test("retirePlugin removes every contribution and runs cleanups", () => {
  const registry = new ContributionRegistry();
  let cleaned = 0;
  registry.activateGeneration("demo", "gen_1", [
    {
      cleanup: () => {
        cleaned += 1;
      },
      contributionId: "progress-card",
      payload: rendererV1,
      slot: "conversation.node",
    },
  ]);
  assert.equal(registry.retirePlugin("demo"), true);
  assert.equal(cleaned, 1);
  assert.equal(registry.retirePlugin("demo"), false);
  assert.equal(registry.pluginCount, 0);
});

test("view is deterministic across activation order", () => {
  const build = (order: string[]): ContributionRegistry => {
    const registry = new ContributionRegistry();
    for (const pluginId of order) {
      registry.activateGeneration(pluginId, "gen_1", [
        {
          contributionId: `${pluginId}-panel`,
          payload: { plugin: pluginId },
          slot: "workspace.panel",
        },
      ]);
    }
    return registry;
  };
  const a = build(["alpha", "beta", "gamma"]);
  const b = build(["gamma", "alpha", "beta"]);
  assert.deepEqual(a.view().lists, b.view().lists);
});
