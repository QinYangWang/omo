"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

// Per-million-token fallback rates for models whose registry pricing is zero.
// kimi-coding/k3-256k ships with cost {0,0,0,0} upstream; mirror Kimi K3 rates.
const COST_OVERRIDES = {
  "kimi-coding/k3-256k": {
    cacheRead: 0.3,
    cacheWrite: 0,
    input: 3,
    output: 15,
  },
};

function addUsage(record, totals, providers) {
  const { message, type } = record || {};
  if (type !== "message" || message?.role !== "assistant" || !message.usage) {
    return;
  }
  const { model = "unknown", provider = "unknown", usage } = message;
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  const rate = COST_OVERRIDES[`${provider}/${model}`];
  const useOverride = rate && Number(usage.cost?.total || 0) === 0;
  const cost = useOverride
    ? (input * rate.input +
        output * rate.output +
        cacheRead * rate.cacheRead +
        cacheWrite * rate.cacheWrite) /
      1e6
    : Number(usage.cost?.total || 0);
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
  totals.cost += cost;
  // Cache savings = cache-read tokens billed at the model's full input price
  // minus the actual (discounted) cache-read cost recorded by pi.
  const inputPrice = useOverride
    ? rate.input / 1e6
    : input > 0
      ? Number(usage.cost?.input || 0) / input
      : 0;
  const cacheReadCost = useOverride
    ? (cacheRead * rate.cacheRead) / 1e6
    : Number(usage.cost?.cacheRead || 0);
  totals.savings += Math.max(0, cacheRead * inputPrice - cacheReadCost);
  const key = `${provider}/${model}`;
  const row = providers.get(key) || {
    cost: 0,
    messages: 0,
    model,
    provider,
    tokens: 0,
  };
  row.messages += 1;
  row.tokens += input + output + cacheWrite;
  row.cost += cost;
  providers.set(key, row);
}

async function readUsageFile(file, totals, providers) {
  let lines;
  try {
    lines = (await fs.readFile(file, "utf8")).split("\n");
  } catch {
    return;
  }
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    addUsage(record, totals, providers);
  }
}

async function walk(folder, totals, providers) {
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(file, totals, providers);
        return;
      }
      if (entry.name.endsWith(".jsonl")) {
        await readUsageFile(file, totals, providers);
      }
    })
  );
}

async function usageSnapshot(sessionRoot) {
  const totals = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    input: 0,
    output: 0,
    savings: 0,
  };
  const providers = new Map();
  await walk(sessionRoot, totals, providers);
  return {
    providers: [...providers.values()].sort((a, b) => b.cost - a.cost),
    totals,
  };
}

module.exports = { usageSnapshot };
