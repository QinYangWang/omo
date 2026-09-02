const fs = require("node:fs/promises");
const path = require("node:path");

async function usageSnapshot(sessionRoot) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const providers = new Map();
  async function walk(folder) {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".jsonl")) {
        let lines;
        try { lines = (await fs.readFile(file, "utf8")).split("\n"); } catch { continue; }
        for (const line of lines) {
          let record; try { record = JSON.parse(line); } catch { continue; }
          if (record?.type !== "message" || record.message?.role !== "assistant" || !record.message.usage) continue;
          const usage = record.message.usage;
          const provider = record.message.provider || "unknown";
          const model = record.message.model || "unknown";
          const input = Number(usage.input || 0), output = Number(usage.output || 0);
          const cacheRead = Number(usage.cacheRead || 0), cacheWrite = Number(usage.cacheWrite || 0);
          const cost = Number(usage.cost?.total || 0);
          totals.input += input; totals.output += output; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite; totals.cost += cost;
          const key = `${provider}/${model}`;
          const row = providers.get(key) || { provider, model, messages: 0, tokens: 0, cost: 0 };
          row.messages += 1; row.tokens += input + output + cacheWrite; row.cost += cost; providers.set(key, row);
        }
      }
    }
  }
  await walk(sessionRoot);
  return { totals, providers: [...providers.values()].sort((a, b) => b.cost - a.cost) };
}

module.exports = { usageSnapshot };
