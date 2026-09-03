"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

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
  const cost = Number(usage.cost?.total || 0);
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
  totals.cost += cost;
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
  const totals = { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0 };
  const providers = new Map();
  await walk(sessionRoot, totals, providers);
  return {
    providers: [...providers.values()].sort((a, b) => b.cost - a.cost),
    totals,
  };
}

module.exports = { usageSnapshot };
