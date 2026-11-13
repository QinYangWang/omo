import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createModels, createProvider, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createSubagentsExtension } from "./agents";
import { createHostSqlite, hostLog } from "./host";
import { AgentTracker, setSessionId, trackConversation, yieldToWatch, type RunMetric } from "./metrics";
import { setSkills, skillsExtension, type SkillInfo } from "./skills";
import { SYSTEM_INSTRUCTIONS, workspaceExtension } from "./tools";

type TeamBot = {
  id: string;
  name: string;
  instructions?: string;
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  conversationId?: string;
};

export type TeamConfig = {
  dbPath: string;
  teamId?: string;
  provider: string;
  model: string;
  customProviders?: CustomProviderSpec[];
  workspace: string;
  credentials?: Record<string, string>;
  maxTokens?: number;
  thinking?: ModelThinkingLevel;
  maxTurns?: number;
  skills?: SkillInfo[];
  bots: TeamBot[];
};

type MessageView = { id: number; role: "user" | "assistant"; text: string };

type BotSnapshot = {
  botId: string;
  status: "idle" | "running" | "tool" | "error";
  messages: MessageView[];
  partial: string;
  tool?: { name: string; status: string };
  failure?: string;
  metrics?: RunMetric;
};

type BotRuntime = {
  id: string;
  name: string;
  conversationId: string;
  conversation: any;
  watch: any;
  tracker: AgentTracker;
};

type Active = {
  harness: Harness;
  registry: any;
  model: { provider: string; modelId: string };
  maxTurns: number;
  bots: Map<string, BotRuntime>;
  onEvent: (kind: string, json: string) => void;
};

let active: Active | null = null;

const ctx = BACKGROUND_CONTEXT;
const DEFAULT_MAX_TURNS = 40;
const TEAM_INSTRUCTIONS = `You are one Bot of a team of long-lived Bots running in omo.

You work in the user's workspace. Read before you change anything, keep edits small and focused, and say which files you touched.
Other Bots exist; the user talks to each of you separately. If a request belongs to another Bot, say so instead of guessing.
Reply in the user's language and keep it short.`;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// supportedThinking is the levels a model takes: a model without reasoning
// only runs with thinking off, and a level mapped to null is unsupported.
const supportedThinking = (model: any) => {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
};

const modelSummary = (model: any) => ({
  id: String(model?.id ?? ""),
  name: String(model?.name ?? model?.id ?? ""),
  api: String(model?.api ?? ""),
  reasoning: !!model?.reasoning,
  thinking: supportedThinking(model),
  input: Array.isArray(model?.input) ? model.input.map(String) : ["text"],
  contextWindow: Number(model?.contextWindow ?? 0),
  maxTokens: Number(model?.maxTokens ?? 0),
});

// DeepSeek's OpenAI-compatible endpoint is the first target: a 64K window,
// a budget of 8K answers, and its reasoner models report thinking tokens.
const modelDefaults = (id: string) => {
  if (/deepseek/i.test(id)) {
    return { contextWindow: 65_536, maxTokens: 8_192, reasoning: /reasoner|think|r1/i.test(id) };
  }
  return { contextWindow: 128_000, maxTokens: 4_096, reasoning: false };
};

type CustomProviderSpec = { id: string; name: string; baseUrl: string; models?: string[] };

const customModel = (spec: CustomProviderSpec, id: string, maxTokens?: number) => {
  const defaults = modelDefaults(id);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: spec.id,
    baseUrl: spec.baseUrl,
    reasoning: defaults.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: maxTokens && maxTokens > 0 ? maxTokens : defaults.maxTokens,
  };
};

const customProvider = (spec: CustomProviderSpec, maxTokens?: number) =>
  createProvider({
    id: spec.id,
    name: spec.name,
    baseUrl: spec.baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        resolve: async ({ credential }: any) => ({
          auth: credential?.key ? { apiKey: credential.key } : {},
        }),
      },
    },
    models: (spec.models ?? []).map((id) => customModel(spec, id, maxTokens) as any),
    api: { stream: openAICompletions.stream, streamSimple: openAICompletions.streamSimple },
  });
const memoryCredentialStore = (keys: Record<string, string> | undefined) => {
  const values = new Map(Object.entries(keys ?? {}).filter(([, value]) => typeof value === "string" && value !== ""));
  const read = async (providerId: string) => {
    const key = values.get(providerId);
    return key ? ({ type: "api_key", key } as const) : undefined;
  };
  return {
    read,
    list: async () => Array.from(values.keys()).map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: async (providerId: string, fn: (current: any) => Promise<any>) => {
      const next = await fn(await read(providerId));
      if (next === undefined) return await read(providerId);
      if (next?.type === "api_key" && next.key) values.set(providerId, String(next.key));
      else values.delete(providerId);
      return next;
    },
    delete: async (providerId: string) => {
      values.delete(providerId);
    },
  };
};

export function listCatalog(customProvidersJson = "[]"): string {
  const providers = builtinProviders().map((provider: any) => ({
    id: String(provider.id),
    name: String(provider.name),
    baseUrl: String(provider.baseUrl ?? ""),
    authName: String(provider.auth?.apiKey?.name ?? "API key"),
    models: (provider.getModels?.() ?? []).map(modelSummary),
  }));
  let specs: CustomProviderSpec[] = [];
  try {
    const parsed = JSON.parse(customProvidersJson);
    if (Array.isArray(parsed)) specs = parsed as CustomProviderSpec[];
  } catch {}
  for (const spec of specs) {
    providers.unshift({
      id: String(spec.id ?? ""),
      name: String(spec.name ?? spec.id ?? "Custom"),
      baseUrl: String(spec.baseUrl ?? ""),
      authName: "API key",
      models: (spec.models ?? []).map((id) => modelSummary(customModel(spec, String(id)))),
    });
  }
  return JSON.stringify({ providers });
}

const textOf = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
};

const buildSnapshot = (botId: string, value: any, metrics?: RunMetric): BotSnapshot => {
  const messages: MessageView[] = [];
  for (const entry of value?.entries ?? []) {
    if (entry.kind === "pi.user") {
      const text = textOf(entry.model?.[0]);
      if (text) messages.push({ id: Number(entry.id), role: "user", text });
    } else if (entry.kind === "pi.assistant") {
      const text = textOf(entry.model?.[0]);
      if (text) messages.push({ id: Number(entry.id), role: "assistant", text });
    }
  }
  const live = value?.docs?.["pi.live"] ?? {};
  const partial = live.generation?.message ? textOf(live.generation.message) : "";
  const slots = Array.isArray(live.tools) ? live.tools : [];
  const lastTool = slots[slots.length - 1];
  const failure = live.runFailure
    ? `${live.runFailure.reason}${live.runFailure.detail ? ": " + live.runFailure.detail : ""}`
    : undefined;
  let status: BotSnapshot["status"] = "idle";
  if (live.run) status = lastTool && lastTool.status !== "done" ? "tool" : "running";
  return {
    botId,
    status,
    messages,
    partial,
    tool: lastTool ? { name: String(lastTool.name ?? ""), status: String(lastTool.status ?? "") } : undefined,
    failure,
    metrics,
  };
};

const emit = (kind: string, payload: unknown) => {
  if (!active) return;
  try {
    active.onEvent(kind, JSON.stringify(payload));
  } catch (error) {
    hostLog("error", `${kind} emit failed: ${String(error)}`);
  }
};

const emitBot = (bot: BotRuntime, metrics?: RunMetric) =>
  emit("bot", buildSnapshot(bot.id, bot.watch.value, metrics));

const botAgent = (bot: TeamBot, cfg: TeamConfig, maxTurns: number) => ({
  model: bot.model
    ? { provider: bot.provider || cfg.provider, modelId: bot.model }
    : { provider: cfg.provider, modelId: cfg.model },
  instructions: `${TEAM_INSTRUCTIONS}\n\nYour name is ${bot.name}.${bot.instructions ? "\n\n" + bot.instructions : ""}\n\n${SYSTEM_INSTRUCTIONS}`,
  cwd: cfg.workspace,
  maxTurns,
  thinkingLevel: bot.thinking || cfg.thinking,
});

export async function openTeam(cfg: TeamConfig, onEvent: (kind: string, json: string) => void): Promise<void> {
  try {
    await closeTeam();
    hostLog("info", `opening team model=${cfg.model} workspace=${cfg.workspace} bots=${(cfg.bots ?? []).length}`);
    if (!Array.isArray(cfg.bots) || cfg.bots.length === 0) throw new Error("the team has no Bots");

    setSessionId(cfg.teamId ?? "");
    setSkills(cfg.skills ?? []);

    const credentials = memoryCredentialStore(cfg.credentials);
    const models = createModels({ credentials });
    for (const provider of builtinProviders()) models.setProvider(provider);
    for (const spec of cfg.customProviders ?? []) models.setProvider(customProvider(spec, cfg.maxTokens));

    const defaultModel = models.getModel(cfg.provider, cfg.model);
    if (!defaultModel) {
      throw new Error(`Model ${cfg.provider}/${cfg.model} is not in the loaded pi-ai catalog`);
    }

    const registry = createRegistry();
    registry.install(workspaceExtension);
    registry.install(skillsExtension);

    const storage = await SqliteStorage.open(createHostSqlite());
    const harness = await Harness.open(storage, { models, registry }, ctx);
    registry.install(createSubagentsExtension(harness));

    const maxTurns = cfg.maxTurns && cfg.maxTurns > 0 ? cfg.maxTurns : DEFAULT_MAX_TURNS;
    const team: Active = {
      harness,
      registry,
      model: { provider: cfg.provider, modelId: cfg.model },
      maxTurns,
      bots: new Map(),
      onEvent,
    };
    active = team;

    for (const spec of cfg.bots) {
      const agent = botAgent(spec, cfg, maxTurns);
      let conversation: any;
      if (spec.conversationId) {
        conversation = await harness.conversation(spec.conversationId as any, ctx);
      }
      if (!conversation) {
        conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
        emit("bot_session", { botId: spec.id, conversationId: String(conversation.id) });
      }
      await conversation.configure(agent, ctx);
      const watch = await conversation.watch(ctx);
      const tracker = trackConversation(new AgentTracker(String(conversation.id), spec.name));
      tracker.attach(watch, false);
      const bot: BotRuntime = {
        id: spec.id,
        name: spec.name,
        conversationId: String(conversation.id),
        conversation,
        watch,
        tracker,
      };
      team.bots.set(spec.id, bot);
      watch.start((call: any) => {
        if (call.kind !== "value") return;
        tracker.observe(call.value);
        emitBot(bot);
      });
      emitBot(bot);
    }

    emit("team", { ready: true, bots: cfg.bots.map((spec) => ({ id: spec.id, name: spec.name })) });
    harness.resume();
    hostLog("info", "team ready");
  } catch (error: any) {
    hostLog("error", `openTeam failed: ${String(error?.stack ?? error)}`);
    onEvent("team", JSON.stringify({ ready: false, failure: String(error?.message ?? error) }));
  }
}

const botOf = (botId: string): BotRuntime => {
  const bot = active?.bots.get(botId);
  if (!bot) throw new Error(`no Bot ${botId} in the open team`);
  return bot;
};

export async function sendToBot(botId: string, text: string, onDone: (json: string) => void): Promise<void> {
  try {
    if (!active) throw new Error("no open team");
    const bot = botOf(botId);
    bot.tracker.begin();
    const submission = await bot.conversation.submit({ type: "input", content: text }, ctx);
    const settled = await submission.wait(ctx);
    await yieldToWatch();
    const failure =
      settled.status === "done" ? undefined : `${settled.reason}${settled.detail ? ": " + settled.detail : ""}`;
    const snapshot = buildSnapshot(bot.id, bot.watch.value, bot.tracker.end(failure));
    if (settled.status !== "done") snapshot.failure = snapshot.failure ?? failure;
    emit("bot", snapshot);
    onDone(JSON.stringify(snapshot));
  } catch (error: any) {
    hostLog("error", `send failed: ${String(error?.stack ?? error)}`);
    const failure = String(error?.message ?? error);
    let snapshot: BotSnapshot = { botId, status: "error", messages: [], partial: "", failure };
    try {
      const bot = botOf(botId);
      snapshot = buildSnapshot(bot.id, bot.watch.value, bot.tracker.end(failure));
      snapshot.failure = failure;
    } catch {}
    emit("bot", snapshot);
    onDone(JSON.stringify(snapshot));
  }
}

export async function abortBot(botId: string, onDone: (json: string) => void): Promise<void> {
  try {
    if (!active) throw new Error("no open team");
    const bot = botOf(botId);
    await bot.conversation.abort(ctx);
    const snapshot = buildSnapshot(bot.id, bot.watch.value);
    snapshot.status = "idle";
    emit("bot", snapshot);
    onDone(JSON.stringify(snapshot));
  } catch (error: any) {
    hostLog("error", `abort failed: ${String(error?.stack ?? error)}`);
    onDone(JSON.stringify({ error: String(error?.message ?? error) }));
  }
}

export async function closeTeam(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  for (const bot of current.bots.values()) {
    try {
      await bot.watch.stop();
    } catch {}
    await bot.tracker.stop();
  }
  try {
    await current.harness.close(ctx);
  } catch (error) {
    hostLog("error", `close failed: ${String(error)}`);
  }
}

declare const __pi_register: (name: string, fn: unknown) => void;
__pi_register("openTeam", openTeam);
__pi_register("sendToBot", sendToBot);
__pi_register("abortBot", abortBot);
__pi_register("closeTeam", closeTeam);
__pi_register("listCatalog", listCatalog);
