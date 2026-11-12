import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createHostSqlite, hostLog } from "./host";
import { SYSTEM_INSTRUCTIONS, workspaceExtension } from "./tools";

export type SessionConfig = {
  dbPath: string;
  baseUrl: string;
  provider: string;
  model: string;
  customModels?: string[];
  workspace: string;
  credentials?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
};

type MessageView = { id: number; role: "user" | "assistant"; text: string };

type Snapshot = {
  ready: boolean;
  status: "idle" | "running" | "tool" | "error";
  messages: MessageView[];
  partial: string;
  tool?: { name: string; status: string; detail?: string };
  failure?: string;
};

type Active = {
  harness: Harness;
  root: any;
  watch: any;
  onState: (json: string) => void;
};

let active: Active | null = null;

const ctx = BACKGROUND_CONTEXT;
const CUSTOM_PROVIDER_ID = "openai-compatible";

const modelSummary = (model: any) => ({
  id: String(model?.id ?? ""),
  name: String(model?.name ?? model?.id ?? ""),
  api: String(model?.api ?? ""),
  reasoning: !!model?.reasoning,
  input: Array.isArray(model?.input) ? model.input.map(String) : ["text"],
  contextWindow: Number(model?.contextWindow ?? 0),
  maxTokens: Number(model?.maxTokens ?? 0),
});

const customModel = (cfg: SessionConfig) => ({
  id: cfg.model,
  name: cfg.model,
  api: "openai-completions",
  provider: CUSTOM_PROVIDER_ID,
  baseUrl: cfg.baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: cfg.maxTokens ?? 4096,
  samplingParams: typeof cfg.temperature === "number" ? { temperature: cfg.temperature } : undefined,
});

const customModelIDs = (cfg: SessionConfig) => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [cfg.model, ...(cfg.customModels ?? [])]) {
    const value = String(id ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
};

const customProvider = (cfg: SessionConfig) =>
  createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: cfg.baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        resolve: async ({ credential }: any) => ({
          auth: credential?.key ? { apiKey: credential.key } : {},
        }),
      },
    },
    models: customModelIDs(cfg).map((id) => customModel({ ...cfg, model: id }) as any),
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

export function listCatalog(baseUrl: string, model: string, customModelsJson = "[]"): string {
  const providers = builtinProviders().map((provider: any) => ({
    id: String(provider.id),
    name: String(provider.name),
    baseUrl: String(provider.baseUrl ?? ""),
    authName: String(provider.auth?.apiKey?.name ?? "API key"),
    models: (provider.getModels?.() ?? []).map(modelSummary),
  }));
  if (baseUrl || model) {
    let customModels: string[] = [];
    try {
      const parsed = JSON.parse(customModelsJson);
      if (Array.isArray(parsed)) customModels = parsed.map(String);
    } catch {}
    const ids = customModelIDs({ baseUrl, model, customModels } as SessionConfig);
    providers.unshift({
      id: CUSTOM_PROVIDER_ID,
      name: "OpenAI-compatible",
      baseUrl,
      authName: "API key",
      models: baseUrl ? ids.map((id) => modelSummary(customModel({ baseUrl, model: id } as SessionConfig))) : [],
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

const buildSnapshot = (value: any, ready = true): Snapshot => {
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
  const generation = live.generation;
  const partial = generation?.message ? textOf(generation.message) : "";
  const slots = Array.isArray(live.tools) ? live.tools : [];
  const lastTool = slots[slots.length - 1];
  const failure = live.runFailure ? `${live.runFailure.reason}${live.runFailure.detail ? ": " + live.runFailure.detail : ""}` : undefined;

  let status: Snapshot["status"] = "idle";
  if (live.run) {
    status = lastTool && lastTool.status !== "done" ? "tool" : "running";
  }

  return {
    ready,
    status,
    messages,
    partial,
    tool: lastTool ? { name: String(lastTool.name ?? ""), status: String(lastTool.status ?? "") } : undefined,
    failure,
  };
};

const emit = (snapshot: Snapshot) => {
  if (!active) return;
  try {
    active.onState(JSON.stringify(snapshot));
  } catch (error) {
    hostLog("error", `onState failed: ${String(error)}`);
  }
};

export async function openSession(cfg: SessionConfig, onState: (json: string) => void): Promise<void> {
  try {
    await closeSession();
    hostLog("info", `opening session model=${cfg.model} workspace=${cfg.workspace}`);

    const credentials = memoryCredentialStore(cfg.credentials);
    const models = createModels({ credentials });
    for (const provider of builtinProviders()) models.setProvider(provider);
    if (cfg.provider === CUSTOM_PROVIDER_ID) {
      if (!cfg.baseUrl) throw new Error("base URL is required for the OpenAI-compatible provider");
      models.setProvider(customProvider(cfg));
    }
    const model = models.getModel(cfg.provider, cfg.model);
    if (!model) {
      throw new Error(`Model ${cfg.provider}/${cfg.model} is not in the loaded pi-ai catalog`);
    }

    const registry = createRegistry();
    registry.install(workspaceExtension);

    const storage = await SqliteStorage.open(createHostSqlite());
    const harness = await Harness.open(storage, { models, registry }, ctx);
    const root = await harness.root(ctx, {
      agent: {
        model: { provider: cfg.provider, modelId: cfg.model },
        instructions: SYSTEM_INSTRUCTIONS,
        cwd: cfg.workspace,
      },
    });
    // root() only applies `agent` when it creates a conversation. Reopening
    // an existing session must update its persisted model and workspace.
    await root.configure(
      {
        model: { provider: cfg.provider, modelId: cfg.model },
        instructions: SYSTEM_INSTRUCTIONS,
        cwd: cfg.workspace,
      },
      ctx,
    );

    const watch = await root.watch(ctx);
    active = { harness, root, watch, onState };
    emit(buildSnapshot(watch.value));

    watch.start((call: any) => {
      if (call.kind !== "value") return;
      emit(buildSnapshot(call.value));
    });

    harness.resume();
    hostLog("info", "session ready");
  } catch (error: any) {
    hostLog("error", `openSession failed: ${String(error?.stack ?? error)}`);
    onState(JSON.stringify({ ready: false, status: "error", messages: [], partial: "", failure: String(error?.message ?? error) }));
  }
}

export async function sendPrompt(text: string, onDone: (json: string) => void): Promise<void> {
  try {
    if (!active) throw new Error("no active session");
    const { root } = active;
    const submission = await root.submit({ type: "input", content: text }, ctx);
    const settled = await submission.wait(ctx);
    const snapshot = buildSnapshot(active.watch.value);
    if (settled.status !== "done") {
      snapshot.failure = snapshot.failure ?? `${settled.reason}${settled.detail ? ": " + settled.detail : ""}`;
    }
    emit(snapshot);
    onDone(JSON.stringify(snapshot));
  } catch (error: any) {
    hostLog("error", `send failed: ${String(error?.stack ?? error)}`);
    const snapshot: Snapshot = {
      ready: true,
      status: "error",
      messages: active ? buildSnapshot(active.watch.value).messages : [],
      partial: "",
      failure: String(error?.message ?? error),
    };
    emit(snapshot);
    onDone(JSON.stringify(snapshot));
  }
}

export async function abortSession(onDone: (json: string) => void): Promise<void> {
  try {
    if (!active) throw new Error("no active session");
    await active.root.abort(ctx);
    const snapshot = buildSnapshot(active.watch.value);
    snapshot.status = "idle";
    emit(snapshot);
    onDone(JSON.stringify(snapshot));
  } catch (error: any) {
    hostLog("error", `abort failed: ${String(error?.stack ?? error)}`);
    onDone(JSON.stringify({ error: String(error?.message ?? error) }));
  }
}

export async function closeSession(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  try {
    await current.watch.stop();
  } catch {}
  try {
    await current.harness.close(ctx);
  } catch (error) {
    hostLog("error", `close failed: ${String(error)}`);
  }
}

declare const __pi_register: (name: string, fn: unknown) => void;
__pi_register("openSession", openSession);
__pi_register("sendPrompt", sendPrompt);
__pi_register("abortSession", abortSession);
__pi_register("closeSession", closeSession);
__pi_register("listCatalog", listCatalog);
