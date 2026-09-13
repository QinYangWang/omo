/**
 * P0 experiment 2 — Chord reload boundaries (plan §13 P0 交付 5, §3.3.6-8, §7.4).
 *
 * Scenarios:
 *   S1 same-shape reload: stable service handle swaps to the new
 *      implementation; old facet is deactivated + disposed.
 *   S2 failed reload: a candidate whose setup throws rejects the reload and
 *      keeps the previous generation serving.
 *   S3 drain: reload does NOT wait for in-flight calls on the old generation
 *      (old closures still finish) — omo must implement its own call barrier
 *      before switching (§7.5).
 *   S4 structural change: reload() rejects facet ids that are not active;
 *      graph changes require a new host capsule (§7.4 C).
 *   S5 self-requested reload: a plugin asks an out-of-host manager
 *      asynchronously; no deadlock (§7.3).
 *   S6 leak smoke: 200 reload cycles keep setup/dispose balanced and heap
 *      growth bounded.
 *   S7 VM generation loader: bundled generations load through
 *      createFacetBundleLoader with integrity checks; a reload swaps module
 *      state completely (fresh module-level counters).
 *
 * Run: node --no-warnings experiments/p0/chord-reload.mjs
 * Exit code 0 = all assertions held; a report is printed to stdout.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFacetHost,
  defineFacet,
  defineService,
} from "@earendil-works/chord";
import { bundleFacets } from "@earendil-works/chord/bundler";
import { createFacetBundleLoader } from "@earendil-works/chord/node";

const report = { assertions: [], ok: true };
const check = (name, condition, detail = "") => {
  report.assertions.push({ detail, name, ok: condition });
  if (!condition) {
    report.ok = false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDirs = [];

try {
  // --- S1 same-shape reload -------------------------------------------------
  {
    const greeter = defineService("s1.greeter", { local: true });
    const log = [];
    const makeFacet = (tag) =>
      defineFacet({
        id: "greeter",
        setup(env) {
          env.provide(greeter, { greet: async (name) => `${tag}:${name}` });
          env.own(() => log.push(`dispose:${tag}`));
          env.onDeactivate(() => log.push(`deactivate:${tag}`));
        },
      });
    let handle;
    const consumer = defineFacet({
      id: "consumer",
      setup(env) {
        handle = env.use(greeter);
      },
    });
    const host = await createFacetHost({
      facets: [makeFacet("v1"), consumer],
    });
    const before = await handle.greet("x");
    await host.reload([makeFacet("v2")]);
    const after = await handle.greet("x");
    check(
      "S1.handleStableAcrossReload",
      before === "v1:x" && after === "v2:x",
      JSON.stringify({ after, before })
    );
    check(
      "S1.oldFacetDeactivatedAndDisposed",
      log.includes("deactivate:v1") && log.includes("dispose:v1"),
      JSON.stringify(log)
    );
    await host.dispose();
  }

  // --- S2 failed reload keeps old generation --------------------------------
  {
    const svc = defineService("s2.svc", { local: true });
    const good = defineFacet({
      id: "svc",
      setup(env) {
        env.provide(svc, { ping: async () => "good" });
      },
    });
    const bad = defineFacet({
      id: "svc",
      setup() {
        throw new Error("boom in setup");
      },
    });
    let handle;
    const consumer = defineFacet({
      id: "consumer",
      setup(env) {
        handle = env.use(svc);
      },
    });
    const host = await createFacetHost({ facets: [good, consumer] });
    const rejected = await host.reload([bad]).then(
      () => false,
      (error) => error instanceof Error && error.message.includes("boom")
    );
    check("S2.failedCandidateRejectsReload", rejected);
    check("S2.oldGenerationKeepsServing", (await handle.ping()) === "good");
    await host.dispose();
  }

  // --- S3 reload does not drain in-flight calls ------------------------------
  {
    const svc = defineService("s3.svc", { local: true });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const v1 = defineFacet({
      id: "svc",
      setup(env) {
        env.provide(svc, {
          slow: async () => {
            await gate;
            return "v1:slow-done";
          },
        });
      },
    });
    const v2 = defineFacet({
      id: "svc",
      setup(env) {
        env.provide(svc, { slow: async () => "v2:fast" });
      },
    });
    let handle;
    const consumer = defineFacet({
      id: "consumer",
      setup(env) {
        handle = env.use(svc);
      },
    });
    const host = await createFacetHost({ facets: [v1, consumer] });
    const inFlight = handle.slow();
    await sleep(10);
    let reloadSettledEarly = false;
    const reloading = host.reload([v2]).then(() => {
      reloadSettledEarly = true;
    });
    await sleep(30);
    check(
      "S3.reloadDoesNotWaitForInflight",
      reloadSettledEarly === true,
      "old generation disposed while its call was still running (§7.5 needs an omo call barrier)"
    );
    release();
    const inFlightResult = await inFlight;
    await reloading;
    check(
      "S3.inflightCallCompletesOnOldClosure",
      inFlightResult === "v1:slow-done"
    );
    await host.dispose();
  }

  // --- S4 structural change requires a new host ------------------------------
  {
    const svcA = defineService("s4.a", { local: true });
    const svcB = defineService("s4.b", { local: true });
    const facetA = defineFacet({
      id: "a",
      setup(env) {
        env.provide(svcA, { ping: async () => "a" });
      },
    });
    const facetB = defineFacet({
      id: "b",
      setup(env) {
        env.provide(svcB, { ping: async () => "b" });
      },
    });
    const host = await createFacetHost({ facets: [facetA] });
    const rejected = await host.reload([facetB]).then(
      () => false,
      (error) => error instanceof Error
    );
    check(
      "S4.reloadRejectsUnknownFacetId",
      rejected,
      "structural graph changes need a new host capsule (§7.4 C)"
    );
    await host.dispose();
    const capsule = await createFacetHost({ facets: [facetA, facetB] });
    check("S4.newHostCapsuleWorks", capsule !== undefined);
    await capsule.dispose();
  }

  // --- S5 self-requested reload through an out-of-host manager ---------------
  {
    const managerSvc = defineService("s5.manager", { local: true });
    const dataSvc = defineService("s5.data", { local: true });
    const log = [];
    const holder = { host: undefined };
    const makePlugin = (tag) =>
      defineFacet({
        id: "plugin",
        setup(env) {
          const manager = env.use(managerSvc);
          env.provide(dataSvc, { version: async () => tag });
          env.own(() => log.push(`dispose:${tag}`));
          log.push(`setup:${tag}`);
          if (tag === "gen1") {
            setTimeout(() => {
              log.push("plugin requests reload");
              manager
                .requestReload()
                .then(() => log.push("reload acknowledged"));
            }, 0);
          }
        },
      });
    const manager = defineFacet({
      id: "manager",
      setup(env) {
        env.provide(managerSvc, {
          requestReload: async () => {
            await holder.host.reload([makePlugin("gen2")]);
          },
        });
      },
    });
    holder.host = await createFacetHost({
      facets: [manager, makePlugin("gen1")],
    });
    await sleep(80);
    check(
      "S5.selfRequestedReloadNoDeadlock",
      log.join(",").includes("setup:gen1,plugin requests reload,setup:gen2") &&
        log.includes("reload acknowledged"),
      JSON.stringify(log)
    );
    await holder.host.dispose();
  }

  // --- S6 leak smoke: 200 reload cycles ---------------------------------------
  {
    const svc = defineService("s6.svc", { local: true });
    let setups = 0;
    let disposals = 0;
    const makeFacet = (generation) =>
      defineFacet({
        id: "svc",
        setup(env) {
          setups += 1;
          env.provide(svc, { id: async () => generation });
          env.own(() => {
            disposals += 1;
          });
        },
      });
    let handle;
    const consumer = defineFacet({
      id: "consumer",
      setup(env) {
        handle = env.use(svc);
      },
    });
    const host = await createFacetHost({ facets: [makeFacet(0), consumer] });
    const heapBefore = process.memoryUsage().heapUsed;
    const cycles = 200;
    for (let generation = 1; generation <= cycles; generation += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: reload cycles are sequential by design
      await host.reload([makeFacet(generation)]);
    }
    const heapAfter = process.memoryUsage().heapUsed;
    check(
      "S6.setupDisposeBalanced",
      setups === cycles + 1 && disposals === cycles,
      `setups=${setups} disposals=${disposals}`
    );
    check("S6.handleServesLatestGeneration", (await handle.id()) === cycles);
    const heapGrowthMb = (heapAfter - heapBefore) / (1024 * 1024);
    check(
      "S6.heapGrowthBounded",
      heapGrowthMb < 64,
      `heap grew ${heapGrowthMb.toFixed(1)} MiB over ${cycles} reloads`
    );
    await host.dispose();
  }

  // --- S7 VM generation loader with real bundles ------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), "omo-p0-chord-bundle-"));
    tempDirs.push(dir);
    const source = (tag) => `
const { defineFacet, defineService } = require("@earendil-works/chord");
let callCount = 0;
const counterSvc = defineService("s7.counter", { local: true });
module.exports.default = defineFacet({
  id: "counter",
  setup(env) {
    env.provide(counterSvc, {
      increment: async () => { callCount += 1; return "${tag}:" + callCount; },
    });
  },
});
`;
    const counterSvc = defineService("s7.counter", { local: true });
    const manifestPaths = {};
    for (const generation of ["gen1", "gen2"]) {
      writeFileSync(join(dir, `${generation}.entry.js`), source(generation));
      // Generations are built sequentially to keep the experiment deterministic.
      // biome-ignore lint/performance/noAwaitInLoops: sequential builds by design
      const built = await bundleFacets({
        entries: { main: join(dir, `${generation}.entry.js`) },
        external: ["@earendil-works/chord"],
        outdir: join(dir, `${generation}-out`),
        platform: "node",
        plugin: { id: "s7-counter", version: generation },
      });
      manifestPaths[generation] = built.manifestPath;
    }
    const loadGeneration = (generation) =>
      createFacetBundleLoader({
        entry: "main",
        manifestPath: manifestPaths[generation],
        resolveExternal: (specifier) =>
          specifier === "@earendil-works/chord"
            ? new URL(import.meta.resolve("@earendil-works/chord"))
            : undefined,
      }).load();

    const loaded1 = await loadGeneration("gen1");
    check(
      "S7.bundleLoadsFacet",
      loaded1.facets.length === 1 && loaded1.facets[0].id === "counter"
    );
    let call;
    const bridge = defineFacet({
      id: "bridge",
      setup(env) {
        const counter = env.use(counterSvc);
        call = () => counter.increment();
      },
    });
    const host = await createFacetHost({ facets: [...loaded1.facets, bridge] });
    const first = await call();
    const second = await call();
    check(
      "S7.generationModuleStateCounts",
      first === "gen1:1" && second === "gen1:2",
      `${first},${second}`
    );
    const loaded2 = await loadGeneration("gen2");
    await host.reload(loaded2.facets);
    const afterSwap = await call();
    check(
      "S7.reloadSwapsToFreshVmGeneration",
      afterSwap === "gen2:1",
      "module-level state is isolated per generation"
    );
    await host.dispose();
    await loaded1.dispose();
    await loaded2.dispose();
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  process.exit(report.assertions.every((assertion) => assertion.ok) ? 0 : 1);
}
