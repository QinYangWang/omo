import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { CoreHarnessRuntime } from "@omo/agent-runtime/core-runtime";
import type { AgentRuntime } from "@omo/agent-runtime/runtime";

/**
 * Wire the upstream-backed runtime for a daemon data directory (plan §4.1:
 * Session Workers embed the core SDK; §3.4: one SQLite database per session
 * under the §5.8 durability baseline via the durable factory).
 */
export const createCoreDaemonRuntime = (options: {
  readonly dataDir: string;
  readonly model: Model<Api>;
  readonly models: Models;
  readonly systemPrompt?: string;
}): AgentRuntime => {
  const directory = join(options.dataDir, "sessions");
  mkdirSync(directory, { recursive: true });
  return CoreHarnessRuntime.create({
    directory,
    model: options.model,
    models: options.models,
    systemPrompt: options.systemPrompt,
  });
};
