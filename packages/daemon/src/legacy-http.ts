import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import {
  loadSkillsFromDir,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeHistoryEntry,
  RuntimeHistoryPage,
  RuntimeHistoryQuery,
  RuntimeLaneSnapshot,
} from "@omo/agent-runtime/runtime";
import type { Principal } from "@omo/control-plane/inbox";
import { OmoCommandError, type OmoErrorCode } from "@omo/protocol/errors";
import { WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./daemon.ts";
import type { DaemonEvent } from "./events.ts";
import type { SessionWorkerSlot } from "./supervisor.ts";
import type { TicketStore } from "./tickets.ts";
import type { WorkspaceRecord } from "./workspaces.ts";
import { isInside } from "./workspaces.ts";

const execFileAsync = promisify(execFile);
const LEGACY_BODY_LIMIT = 16 * 1024 * 1024;
const LEGACY_TEXT_LIMIT = 300 * 1024;
const LEGACY_IMAGE_LIMIT = 5_900_000;
const LEGACY_HISTORY_LIMIT = 1000;
const HISTORY_PAGE_SIZE = 80;
const IMAGE_MIME: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const GIT_FAILURE_PATTERN = /^(fatal|error)/i;
const LEGACY_TERMINAL_STREAM_PATTERN =
  /^\/api\/v1\/terminals\/([^/]+)\/stream$/;
const TERMINAL_STATES = new Set(["cancelled", "completed", "failed"]);

type JsonRecord = Record<string, unknown>;
type LegacyMessage = JsonRecord;

interface LegacyProject {
  readonly cwd: string;
  readonly id: string;
  readonly name: string;
}

interface LegacySession {
  readonly created: number;
  readonly cwd: string;
  readonly firstMessage: string;
  readonly id: string;
  readonly messageCount: number;
  readonly modified: number;
  readonly name?: string;
  readonly path: string;
}

interface LegacySnapshot {
  readonly items: LegacyMessage[];
  readonly metas: {
    readonly absoluteIndex: number;
    readonly id: string;
    readonly userPreview: string;
  }[];
  readonly turnStarts: number[];
}

interface LegacySessionContext {
  readonly actualId: string;
  readonly slot: SessionWorkerSlot;
  readonly workspace: WorkspaceRecord;
}

interface LegacyEventClient {
  readonly actualId: string;
  readonly response: ServerResponse;
  sequence: number;
  readonly sessionKey: string;
}

interface LegacyEventRecord {
  readonly payload: JsonRecord;
  readonly sequence: number;
}

interface LegacyAuthPrompt {
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: string) => void;
}

const LEGACY_EVENT_RETENTION = 2000;
const LEGACY_COMMAND_TIMEOUT_MS = 30_000;
const LEGACY_PACKAGE_TIMEOUT_MS = 120_000;
const LEGACY_TERMINAL_TICKET = "legacy-terminal";
const LEGACY_NPM_NAME_PATTERN = /^(?:@[a-z\d._~-]+\/)?[a-z\d._~-]+$/i;
const LEGACY_MODEL_LEVEL_SUFFIX_PATTERN =
  /:(?:off|minimal|low|medium|high|xhigh|max)$/;
const LEGACY_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LEGACY_SESSION_ROOT = join(LEGACY_AGENT_DIR, "sessions");
const LEGACY_PACKAGE_SOURCE_PATTERN = /^npm:(.+)$/;

const legacyAuthPath = (): string =>
  process.env.OMO_DAEMON_AUTH_PATH ?? join(LEGACY_AGENT_DIR, "auth.json");
const LEGACY_USAGE_OVERRIDE = {
  cacheRead: 0.3,
  cacheWrite: 0,
  input: 3,
  output: 15,
};

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

interface LegacyPackageInfo {
  readonly installedVersion?: string;
  readonly kind: string;
  readonly name: string;
  readonly source: string;
  readonly version?: string;
}

interface LegacyUsageProvider {
  cost: number;
  messages: number;
  readonly model: string;
  readonly provider: string;
  tokens: number;
}

interface LegacyUsageTotals {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  input: number;
  output: number;
  savings: number;
}

interface LegacyQuotaWindow {
  readonly isCurrency?: boolean;
  readonly label: string;
  readonly limitValue: number;
  readonly provider: string;
  readonly resetsAt: string;
  readonly usedPercent: number;
  readonly usedValue: number;
  readonly windowSeconds?: number;
}

interface LegacyQuotaItem {
  readonly error?: { readonly kind: string; readonly message: string };
  readonly label: string;
  readonly provider: string;
  readonly success: boolean;
  readonly windows: LegacyQuotaWindow[];
}

interface LegacyQuotaSnapshot {
  readonly installed: boolean;
  readonly items: LegacyQuotaItem[];
  readonly stale?: boolean;
}

interface LegacyQuotaRuntime {
  readonly getAuth: (providerId: string) => Promise<unknown>;
}

type LegacyQuotaFetcher = (
  piService: { readonly runtime: () => Promise<LegacyQuotaRuntime> },
  agentDir: string,
  force?: boolean,
  authPath?: string
) => Promise<LegacyQuotaSnapshot>;

const require = createRequire(import.meta.url);
let legacyQuotaFetcher: LegacyQuotaFetcher | null | undefined;

const getLegacyQuotaFetcher = (): LegacyQuotaFetcher | undefined => {
  if (legacyQuotaFetcher !== undefined) {
    return legacyQuotaFetcher ?? undefined;
  }
  try {
    const module = require("../../../server/quotas.cjs") as {
      fetchQuotas?: unknown;
    };
    legacyQuotaFetcher =
      typeof module.fetchQuotas === "function"
        ? (module.fetchQuotas as LegacyQuotaFetcher)
        : null;
  } catch {
    legacyQuotaFetcher = null;
  }
  return legacyQuotaFetcher ?? undefined;
};

const newLegacyUsageTotals = (): LegacyUsageTotals => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  input: 0,
  output: 0,
  savings: 0,
});

const readLegacySettings = (): JsonRecord => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(LEGACY_AGENT_DIR, "settings.json"), "utf8")
    );
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
};

const writeLegacySettings = (settings: JsonRecord): void => {
  mkdirSync(LEGACY_AGENT_DIR, { recursive: true });
  writeFileSync(
    join(LEGACY_AGENT_DIR, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`
  );
};

const packageSpec = (
  source: string
): { readonly name: string; readonly version?: string } | undefined => {
  const match = LEGACY_PACKAGE_SOURCE_PATTERN.exec(source);
  if (!match) {
    return undefined;
  }
  const [, spec] = match;
  const separator = spec.startsWith("@")
    ? spec.indexOf("@", 1)
    : spec.lastIndexOf("@");
  const name = separator > 0 ? spec.slice(0, separator) : spec;
  const version = separator > 0 ? spec.slice(separator + 1) : undefined;
  if (
    !LEGACY_NPM_NAME_PATTERN.test(name) ||
    (version !== undefined && !version.trim())
  ) {
    return undefined;
  }
  return { name, version };
};

const installedPackageVersion = (name: string): string | undefined => {
  try {
    const packageJson: unknown = JSON.parse(
      readFileSync(
        join(LEGACY_AGENT_DIR, "npm", "node_modules", name, "package.json"),
        "utf8"
      )
    );
    return asString(asRecord(packageJson)?.version);
  } catch {
    return undefined;
  }
};

const legacyPackages = (): LegacyPackageInfo[] => {
  const settings = readLegacySettings();
  const sources = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  return sources.map((source) => {
    const parsed = packageSpec(source);
    const installedVersion = parsed
      ? installedPackageVersion(parsed.name)
      : undefined;
    return {
      installedVersion,
      kind: source.startsWith("npm:") ? "npm" : "path",
      name: parsed?.name ?? source,
      source,
      version: parsed?.version ?? installedVersion,
    };
  });
};

const legacyModelKey = (provider: string, modelId: string): string =>
  `${provider}/${modelId}`;

const legacyModelEnabled = (
  settings: JsonRecord,
  provider: string,
  modelId: string
): boolean => {
  const patterns = Array.isArray(settings.enabledModels)
    ? settings.enabledModels.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  if (patterns.length === 0) {
    return true;
  }
  const key = legacyModelKey(provider, modelId);
  return patterns.some((pattern) => {
    const source = pattern.replace(LEGACY_MODEL_LEVEL_SUFFIX_PATTERN, "");
    const escaped = source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`
    );
    return regex.test(key) || regex.test(modelId);
  });
};

const legacySkills = (): JsonRecord[] =>
  loadSkillsFromDir({
    dir: join(LEGACY_AGENT_DIR, "skills"),
    source: "user",
  }).skills.map((skill) => ({
    description: skill.description,
    filePath: skill.filePath,
    name: skill.name,
  }));

const installLegacyPackage = async (
  source: string
): Promise<LegacyPackageInfo[]> => {
  const parsed = packageSpec(source);
  if (!parsed) {
    throw new OmoCommandError(
      "unknown_schema",
      "Only npm: package sources are supported"
    );
  }
  const prefix = join(LEGACY_AGENT_DIR, "npm");
  mkdirSync(prefix, { recursive: true });
  await execFileAsync(
    "npm",
    ["install", "--prefix", prefix, source.slice("npm:".length)],
    { cwd: prefix, timeout: LEGACY_PACKAGE_TIMEOUT_MS }
  );
  const settings = readLegacySettings();
  const packages = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  if (!packages.includes(source)) {
    settings.packages = [...packages, source];
    writeLegacySettings(settings);
  }
  return legacyPackages();
};

const removeLegacyPackage = (source: string): LegacyPackageInfo[] => {
  const settings = readLegacySettings();
  const packages = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  settings.packages = packages.filter((entry) => entry !== source);
  writeLegacySettings(settings);
  return legacyPackages();
};

const contentParts = (value: unknown): JsonRecord[] => {
  if (typeof value === "string") {
    return [{ text: value, type: "text" }];
  }
  return Array.isArray(value)
    ? value.flatMap((part) => {
        const record = asRecord(part);
        return record ? [record] : [];
      })
    : [];
};

const textFromContent = (value: unknown): string =>
  contentParts(value)
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");

const stringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
};

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}\n…` : value;

const timestampOf = (value: unknown, fallback: number): number => {
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > LEGACY_BODY_LIMIT) {
      throw new OmoCommandError(
        "quota_exceeded",
        `request body exceeds ${LEGACY_BODY_LIMIT} bytes`
      );
    }
    chunks.push(part);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: OmoCommandError forwards cause to super
    throw new OmoCommandError(
      "unknown_schema",
      "request body must be JSON",
      false,
      {
        cause,
      }
    );
  }
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(data),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(data);
};

const projectFromWorkspace = (workspace: WorkspaceRecord): LegacyProject => ({
  cwd: workspace.path,
  id: workspace.workspaceId,
  name: workspace.name ?? basename(workspace.path),
});

const dateNumber = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const legacyPage = (
  snapshot: LegacySnapshot,
  before?: unknown
): {
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly messages: LegacyMessage[];
} => {
  const totalTurns = snapshot.turnStarts.length;
  const requested = Number(before);
  const endTurn = Number.isFinite(requested)
    ? Math.max(0, Math.min(requested, totalTurns))
    : totalTurns;
  const endMessage =
    endTurn < totalTurns ? snapshot.turnStarts[endTurn] : snapshot.items.length;
  let startTurn = endTurn;
  while (startTurn > 0) {
    const candidateStart = snapshot.turnStarts[startTurn - 1];
    const candidateSize = endMessage - candidateStart;
    const isFirstCandidate = startTurn === endTurn - 1;
    if (
      startTurn < endTurn &&
      !isFirstCandidate &&
      candidateSize > HISTORY_PAGE_SIZE
    ) {
      break;
    }
    startTurn -= 1;
  }
  const startMessage =
    startTurn < totalTurns
      ? snapshot.turnStarts[startTurn]
      : snapshot.items.length;
  return {
    cursor: startTurn,
    hasMore: startTurn > 0,
    messages: snapshot.items.slice(startMessage, endMessage),
  };
};

const recordLegacyUsage = (
  payload: unknown,
  providers: Map<string, LegacyUsageProvider>,
  totals: LegacyUsageTotals
): void => {
  const message = asRecord(payload);
  const usage = asRecord(message?.usage);
  if (message?.role !== "assistant" || !usage) {
    return;
  }
  const amount = (value: unknown): number => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
  };
  const input = amount(usage.input);
  const output = amount(usage.output);
  const cacheRead = amount(usage.cacheRead);
  const cacheWrite = amount(usage.cacheWrite);
  const model = String(message.model ?? "unknown");
  const provider = String(message.provider ?? "unknown");
  const key = `${provider}/${model}`;
  const cost = asRecord(usage.cost);
  const recordedCost = amount(cost?.total);
  const useOverride = key === "kimi-coding/k3-256k" && recordedCost === 0;
  const costTotal = useOverride
    ? (input * LEGACY_USAGE_OVERRIDE.input +
        output * LEGACY_USAGE_OVERRIDE.output +
        cacheRead * LEGACY_USAGE_OVERRIDE.cacheRead +
        cacheWrite * LEGACY_USAGE_OVERRIDE.cacheWrite) /
      1_000_000
    : recordedCost;
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
  totals.cost += costTotal;
  let inputPrice = 0;
  if (useOverride) {
    inputPrice = LEGACY_USAGE_OVERRIDE.input / 1_000_000;
  } else if (input > 0) {
    inputPrice = amount(cost?.input) / input;
  }
  const cacheReadCost = useOverride
    ? (cacheRead * LEGACY_USAGE_OVERRIDE.cacheRead) / 1_000_000
    : amount(cost?.cacheRead);
  totals.savings += Math.max(0, cacheRead * inputPrice - cacheReadCost);
  const row =
    providers.get(key) ??
    ({
      cost: 0,
      messages: 0,
      model,
      provider,
      tokens: 0,
    } satisfies LegacyUsageProvider);
  row.messages += 1;
  row.tokens += input + output + cacheWrite;
  row.cost += costTotal;
  providers.set(key, row);
};

/**
 * Small compatibility surface for the original v1 React page.
 *
 * The public daemon remains v2 internally. This adapter deliberately translates
 * only at the HTTP boundary, so the v2 command, auth and storage contracts stay
 * unchanged while existing v1 clients can keep using /api/v1.
 */
export class LegacyHttpAdapter {
  readonly #daemon: Daemon;
  readonly #aliases = new Map<string, string>();
  readonly #authPrompts = new Map<string, LegacyAuthPrompt>();
  readonly #commandStates = new Map<string, string>();
  readonly #eventClients = new Set<LegacyEventClient>();
  readonly #eventHistory = new Map<string, LegacyEventRecord[]>();
  readonly #eventSequences = new Map<string, number>();
  readonly #laneSessions = new Set<string>();
  readonly #localImports = new Map<string, Promise<string | undefined>>();
  readonly #usageProviders = new Map<string, LegacyUsageProvider>();
  readonly #usageTotals: LegacyUsageTotals = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    input: 0,
    output: 0,
    savings: 0,
  };
  readonly #terminalSocketIds = new Map<WebSocket, string>();
  readonly #terminalSocketDevices = new Map<WebSocket, string>();
  readonly #terminalSockets = new Set<WebSocket>();
  readonly #unsubscribe: () => void;
  #terminalWss: WebSocketServer | undefined;
  #tickets: TicketStore | undefined;

  constructor(daemon: Daemon) {
    this.#daemon = daemon;
    this.#unsubscribe = daemon.events.subscribe((event) =>
      this.#onDaemonEvent(event)
    );
  }

  attach(server: Server, tickets: TicketStore): void {
    this.#tickets = tickets;
    this.#terminalWss = new WebSocketServer({ noServer: true });
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const match = LEGACY_TERMINAL_STREAM_PATTERN.exec(url.pathname);
        if (!match) {
          if (url.pathname.startsWith("/api/v1/terminals/")) {
            socket.destroy();
          }
          return;
        }
        const principal = tickets.consume(
          url.searchParams.get("ticket") ?? "",
          LEGACY_TERMINAL_TICKET
        );
        const terminalId = decodeURIComponent(match[1]);
        if (!(principal && this.#daemon.terminals.get(terminalId))) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\\r\\nconnection: close\\r\\n\\r\\n"
          );
          socket.destroy();
          return;
        }
        this.#terminalWss?.handleUpgrade(request, socket, head, (webSocket) => {
          this.#attachTerminal(webSocket, terminalId, principal, url);
        });
      }
    );
  }

  close(): void {
    this.#unsubscribe();
    for (const client of this.#eventClients) {
      client.response.end();
    }
    this.#eventClients.clear();
    for (const socket of this.#terminalSockets) {
      socket.close();
    }
    this.#terminalSockets.clear();
    this.#terminalSocketIds.clear();
    this.#terminalSocketDevices.clear();
    this.#terminalWss?.close();
    this.#terminalWss = undefined;
    this.#authPrompts.clear();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy route dispatch keeps compatibility paths together
  async handle(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    response: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    if (route[0] === "projects") {
      return this.#projects(method, req, response);
    }
    if (route[0] === "sessions") {
      return this.#sessions(method, route, url, req, response, principal);
    }
    if (route[0] === "pi") {
      return this.#pi(method, route, url, req, response, principal);
    }
    if (route[0] === "events") {
      if (method !== "GET") {
        return false;
      }
      this.#events(url, req, response);
      return true;
    }
    if (route[0] === "terminals") {
      return this.#terminals(method, route, url, req, response, principal);
    }
    if (route[0] === "files") {
      return this.#files(method, route, url, req, response, principal);
    }
    if (route[0] === "git") {
      return this.#git(method, route, url, req, response);
    }
    if (route[0] === "providers") {
      return this.#providers(method, route, req, response);
    }
    if (route[0] === "models") {
      return this.#models(method, req, response);
    }
    if (route[0] === "cwd") {
      if (method !== "GET") {
        return false;
      }
      const [cwd] = this.#daemon.workspaces.roots();
      if (!cwd) {
        throw new OmoCommandError(
          "unknown_workspace",
          "no workspace root configured"
        );
      }
      sendJson(response, 200, { cwd });
      return true;
    }
    if (route[0] === "skills") {
      if (method !== "GET") {
        return false;
      }
      sendJson(response, 200, legacySkills());
      return true;
    }
    if (route[0] === "packages") {
      return this.#packages(method, route, req, response);
    }
    if (route[0] === "quotas") {
      return this.#quotas(method, url, response);
    }
    if (route[0] === "usage") {
      if (method !== "GET") {
        return false;
      }
      sendJson(response, 200, await this.#usageSnapshot());
      return true;
    }
    if (route[0] === "health") {
      if (method !== "GET") {
        return false;
      }
      sendJson(response, 200, {
        capabilities: [
          "pi",
          "events",
          "projects",
          "files",
          "git",
          "providers",
          "models",
          "skills",
          "packages",
          "terminal",
        ],
        ok: true,
        version: 1,
      });
      return true;
    }
    return false;
  }

  #onDaemonEvent(event: DaemonEvent): void {
    if (event.type === "lane") {
      if (event.event.details !== undefined) {
        this.#laneSessions.add(event.sessionId);
      }
      this.#broadcastLaneEvent(
        event.sessionId,
        event.event.details,
        event.event.type
      );
      return;
    }
    if (event.type === "terminal") {
      this.#broadcastTerminalEvent(event);
      return;
    }
    if (event.type !== "command" || event.command.kind !== "prompt") {
      return;
    }
    const { sessionId } = event.command.scope;
    if (!sessionId) {
      return;
    }
    const previous = this.#commandStates.get(event.command.commandId);
    if (previous === event.command.state) {
      return;
    }
    this.#commandStates.set(event.command.commandId, event.command.state);
    if (event.command.state === "running") {
      if (!this.#laneSessions.has(sessionId)) {
        this.#broadcast(sessionId, {
          message: { role: "assistant" },
          type: "message_start",
        });
      }
      return;
    }
    if (!TERMINAL_STATES.has(event.command.state)) {
      return;
    }
    if (event.command.state === "failed") {
      const error = asRecord(event.command.error);
      this.#broadcast(sessionId, {
        message: String(error?.message ?? "Prompt failed on the daemon"),
        type: "omo_error",
      });
    }
    if (!this.#laneSessions.has(sessionId)) {
      this.#broadcast(sessionId, { messages: [], type: "agent_end" });
      // ChatView uses this event to run its existing v1 history synchronizer.
      this.#broadcast(sessionId, { type: "omo_session_file" });
    }
  }

  #recordUsage(payload: unknown): void {
    recordLegacyUsage(payload, this.#usageProviders, this.#usageTotals);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: durable usage aggregation handles paginated session failures independently
  async #usageSnapshot(): Promise<{
    readonly providers: LegacyUsageProvider[];
    readonly totals: LegacyUsageTotals;
  }> {
    const runtimeReadHistory = this.#daemon.runtime.readSessionHistory?.bind(
      this.#daemon.runtime
    );
    if (!runtimeReadHistory && this.#daemon.supervisor.workerCount() === 0) {
      return {
        providers: [...this.#usageProviders.values()].sort(
          (left, right) => right.cost - left.cost
        ),
        totals: this.#usageTotals,
      };
    }
    const providers = new Map<string, LegacyUsageProvider>();
    const totals = newLegacyUsageTotals();
    let summaries: readonly { id: string }[];
    try {
      summaries = await this.#daemon.runtime.listSessions();
    } catch {
      return { providers: [], totals };
    }
    for (const summary of summaries) {
      const activeSession = this.#daemon.supervisor.get(summary.id)?.session;
      let readHistory:
        | ((options?: RuntimeHistoryQuery) => Promise<RuntimeHistoryPage>)
        | undefined;
      if (activeSession) {
        readHistory = (options) => activeSession.readHistory(options);
      } else if (runtimeReadHistory) {
        readHistory = (options) => runtimeReadHistory(summary.id, options);
      }
      if (!readHistory) {
        continue;
      }
      let cursor: string | undefined;
      try {
        for (;;) {
          // biome-ignore lint/performance/noAwaitInLoops: history pages must be read sequentially by cursor.
          const page = await readHistory({
            cursor,
            limit: LEGACY_HISTORY_LIMIT,
          });
          for (const entry of page.entries) {
            if (entry.type === "message") {
              recordLegacyUsage(entry.body, providers, totals);
            }
          }
          if (!page.nextCursor || page.nextCursor === cursor) {
            break;
          }
          cursor = page.nextCursor;
        }
      } catch {
        // A session may be in the middle of a close/recovery transition. Keep
        // the other durable sessions in the aggregate instead of failing the
        // settings page completely.
      }
    }
    return {
      providers: [...providers.values()].sort(
        (left, right) => right.cost - left.cost
      ),
      totals,
    };
  }

  #broadcastLaneEvent(
    actualId: string,
    details: unknown,
    fallbackType: string
  ): void {
    const event = asRecord(details);
    const type = asString(event?.type) ?? fallbackType;
    if (type === "message_end") {
      this.#recordUsage(event?.message);
    }
    if (type === "message_update") {
      this.#broadcast(actualId, {
        assistantMessageEvent: event?.event,
        type: "message_update",
      });
      return;
    }
    if (type === "tool_end") {
      this.#broadcast(actualId, {
        isError: event?.isError === true,
        result: event?.result,
        toolCallId: event?.toolCallId,
        type: "tool_execution_end",
      });
      return;
    }
    if (type === "retry_scheduled" || type === "retry_start") {
      this.#broadcast(actualId, {
        attempt: event?.attempt,
        delayMs: event?.delayMs,
        errorMessage: event?.errorMessage,
        maxAttempts: event?.maxAttempts,
        type: "auto_retry_start",
      });
      return;
    }
    if (type === "retry_end") {
      this.#broadcast(actualId, {
        finalError: event?.finalError,
        success: event?.success === true,
        type: "auto_retry_end",
      });
      return;
    }
    if (type === "run_end") {
      if (event?.error !== undefined) {
        const error = asRecord(event.error);
        this.#broadcast(actualId, {
          message: String(error?.message ?? event.error),
          type: "omo_error",
        });
      }
      this.#broadcast(actualId, { messages: [], type: "agent_end" });
      this.#broadcast(actualId, { type: "omo_session_file" });
      return;
    }
    if (type === "fault" || type === "handler_error") {
      this.#broadcast(actualId, {
        message: String(event?.message ?? event?.error ?? "Agent fault"),
        type: "omo_error",
      });
      return;
    }
    if (
      type === "message_start" ||
      type === "message_end" ||
      type === "tool_start" ||
      type === "tool_update"
    ) {
      this.#broadcast(actualId, event ?? { type });
    }
  }

  #broadcastTerminalEvent(
    event: Extract<DaemonEvent, { type: "terminal" }>
  ): void {
    const payload = event.chunk;
    for (const socket of this.#terminalSockets) {
      if (
        socket.readyState !== WebSocket.OPEN ||
        this.#terminalSocketIds.get(socket) !== event.terminalId
      ) {
        continue;
      }
      try {
        if (event.kind === "output" && payload) {
          socket.send(
            JSON.stringify({
              data: Buffer.from(payload.dataB64, "base64").toString("utf8"),
              nextOffset: payload.nextOffset,
              offset: payload.offset,
              type: "output",
            })
          );
        } else if (event.kind === "exit") {
          socket.send(
            JSON.stringify({
              offset: this.#terminalOffset(event.terminalId),
              type: "exit",
            })
          );
        }
      } catch {
        socket.close();
      }
    }
  }

  #broadcast(actualId: string, payload: JsonRecord): void {
    const sequence = (this.#eventSequences.get(actualId) ?? 0) + 1;
    this.#eventSequences.set(actualId, sequence);
    const history = this.#eventHistory.get(actualId) ?? [];
    history.push({ payload, sequence });
    if (history.length > LEGACY_EVENT_RETENTION) {
      history.splice(0, history.length - LEGACY_EVENT_RETENTION);
    }
    this.#eventHistory.set(actualId, history);
    for (const client of this.#eventClients) {
      if (
        client.actualId !== actualId ||
        client.response.destroyed ||
        sequence <= client.sequence
      ) {
        continue;
      }
      try {
        client.sequence = sequence;
        client.response.write(
          `id: ${sequence}\nevent: message\ndata: ${JSON.stringify({
            payload: { ...payload, sessionId: client.sessionKey },
            sequence,
          })}\n\n`
        );
      } catch {
        this.#eventClients.delete(client);
      }
    }
  }

  #events(url: URL, req: IncomingMessage, response: ServerResponse): void {
    const sessionKey = url.searchParams.get("sessionId") ?? "";
    const actualId =
      sessionKey === "__providers"
        ? sessionKey
        : this.#actualSessionId(sessionKey);
    const after = Math.max(
      0,
      Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0)
    );
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });
    response.write("retry: 1000\n\n");
    const client: LegacyEventClient = {
      actualId,
      response,
      sequence: after,
      sessionKey,
    };
    this.#eventClients.add(client);
    for (const record of this.#eventHistory.get(actualId) ?? []) {
      if (record.sequence <= after) {
        continue;
      }
      response.write(
        `id: ${record.sequence}\nevent: message\ndata: ${JSON.stringify({
          payload: { ...record.payload, sessionId: sessionKey },
          sequence: record.sequence,
        })}\n\n`
      );
      client.sequence = record.sequence;
    }
    const heartbeat = setInterval(() => {
      if (!response.destroyed) {
        response.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);
    const close = () => {
      clearInterval(heartbeat);
      this.#eventClients.delete(client);
    };
    req.on("close", close);
    response.on("close", close);
  }

  #terminalOffset(terminalId: string): number {
    const snapshot = this.#daemon.terminals.snapshot(terminalId);
    return Math.max(
      snapshot?.floor ?? 0,
      snapshot?.tail.at(-1)?.nextOffset ?? 0
    );
  }

  #attachTerminal(
    socket: WebSocket,
    terminalId: string,
    principal: Principal,
    url: URL
  ): void {
    const snapshot = this.#daemon.terminals.snapshot(terminalId);
    if (!snapshot) {
      socket.close(1008, "terminal not found");
      return;
    }
    this.#terminalSockets.add(socket);
    this.#terminalSocketIds.set(socket, terminalId);
    this.#terminalSocketDevices.set(socket, principal.deviceId);
    this.#daemon.connectedDevices.add(principal.deviceId);
    let cursor = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) {
      cursor = 0;
    }
    if (cursor < snapshot.floor) {
      socket.send(JSON.stringify({ offset: snapshot.floor, type: "reset" }));
      cursor = snapshot.floor;
    }
    for (const chunk of snapshot.tail) {
      if (chunk.nextOffset <= cursor) {
        continue;
      }
      socket.send(
        JSON.stringify({
          data: Buffer.from(chunk.dataB64, "base64").toString("utf8"),
          nextOffset: chunk.nextOffset,
          offset: chunk.offset,
          type: "output",
        })
      );
    }
    if (snapshot.terminal.status !== "running") {
      socket.send(
        JSON.stringify({
          offset: this.#terminalOffset(terminalId),
          type: "exit",
        })
      );
    }
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const input = asRecord(message);
      try {
        if (input?.type === "input" && typeof input.data === "string") {
          this.#daemon.terminals.writeInput(terminalId, principal, input.data);
        } else if (
          input?.type === "resize" &&
          typeof input.cols === "number" &&
          typeof input.rows === "number"
        ) {
          this.#daemon.terminals.resize(
            terminalId,
            principal,
            input.cols,
            input.rows
          );
        }
      } catch (error) {
        socket.send(
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
            type: "error",
          })
        );
      }
    });
    socket.on("close", () => {
      this.#terminalSockets.delete(socket);
      this.#terminalSocketIds.delete(socket);
      this.#terminalSocketDevices.delete(socket);
      const deviceStillConnected = [
        ...this.#terminalSocketDevices.values(),
      ].includes(principal.deviceId);
      if (!deviceStillConnected) {
        this.#daemon.connectedDevices.delete(principal.deviceId);
      }
    });
  }

  async #submitLegacyCommand(
    kind: string,
    payload: unknown,
    workspaceId: string,
    principal: Principal,
    sessionId?: string
  ): Promise<JsonRecord> {
    const commandId = `legacy_${kind.replaceAll(".", "_")}_${randomUUID()}`;
    const receipt = this.#daemon.service.submit(
      {
        clientMutationId: commandId,
        commandId,
        kind,
        payload,
        scope: { sessionId, workspaceId },
      },
      principal
    );
    const deadline = Date.now() + LEGACY_COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const command = this.#daemon.service.getCommand(receipt.commandId);
      if (command?.state === "completed") {
        return asRecord(command.result) ?? {};
      }
      if (command?.state === "failed" || command?.state === "cancelled") {
        const error = asRecord(command.error);
        const code = error?.code;
        const allowed = new Set<OmoErrorCode>([
          "internal",
          "operation_mismatch",
          "permission_denied",
          "quota_exceeded",
          "revision_mismatch",
          "storage_unavailable",
          "unknown_command",
          "unknown_schema",
          "unknown_workspace",
        ]);
        throw new OmoCommandError(
          typeof code === "string" && allowed.has(code as OmoErrorCode)
            ? (code as OmoErrorCode)
            : "internal",
          String(error?.message ?? `legacy ${kind} command failed`)
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: legacy HTTP waits on a durable command
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new OmoCommandError(
      "storage_unavailable",
      `legacy ${kind} command did not settle in time`,
      true
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy terminal route compatibility
  async #terminals(
    method: string,
    route: string[],
    _url: URL,
    req: IncomingMessage,
    response: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    if (method === "POST" && route.length === 1) {
      const body = asRecord(await readJsonBody(req));
      const requestedCwd = asString(body?.cwd);
      const fallback =
        requestedCwd ??
        this.#daemon.workspaces.list()[0]?.path ??
        this.#daemon.workspaces.roots()[0];
      if (!fallback) {
        throw new OmoCommandError(
          "unknown_workspace",
          "no workspace configured"
        );
      }
      const workspace = this.#workspaceForPath(fallback);
      const cwd = relative(workspace.path, resolve(fallback)) || ".";
      const result = await this.#submitLegacyCommand(
        "terminal.create",
        {
          cols: Number.isFinite(Number(body?.cols))
            ? Math.max(2, Math.trunc(Number(body?.cols)))
            : 120,
          cwd,
          rows: Number.isFinite(Number(body?.rows))
            ? Math.max(1, Math.trunc(Number(body?.rows)))
            : 30,
        },
        workspace.workspaceId,
        principal
      );
      const terminalId = asString(result.terminalId);
      if (!terminalId) {
        throw new OmoCommandError("internal", "terminal create returned no id");
      }
      await this.#submitLegacyCommand(
        "terminal.control",
        { action: "acquire", terminalId },
        workspace.workspaceId,
        principal
      );
      const tickets = this.#tickets;
      if (!tickets) {
        throw new OmoCommandError(
          "internal",
          "legacy terminal tickets unavailable"
        );
      }
      sendJson(response, 200, {
        offset: 0,
        terminalId,
        ticket: tickets.issue(principal, LEGACY_TERMINAL_TICKET).ticket,
      });
      return true;
    }
    if (method === "DELETE" && route.length === 2) {
      const terminalId = decodeURIComponent(route[1]);
      const terminal = this.#daemon.terminals.get(terminalId);
      if (!terminal) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown terminal ${terminalId}`
        );
      }
      await this.#submitLegacyCommand(
        "terminal.kill",
        { terminalId },
        terminal.workspaceId,
        principal
      );
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (method === "POST" && route.length === 3 && route[2] === "ticket") {
      const terminalId = decodeURIComponent(route[1]);
      const terminal = this.#daemon.terminals.get(terminalId);
      if (!terminal) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown terminal ${terminalId}`
        );
      }
      await this.#submitLegacyCommand(
        "terminal.control",
        { action: "acquire", terminalId },
        terminal.workspaceId,
        principal
      );
      const tickets = this.#tickets;
      if (!tickets) {
        throw new OmoCommandError(
          "internal",
          "legacy terminal tickets unavailable"
        );
      }
      sendJson(response, 200, {
        ticket: tickets.issue(principal, LEGACY_TERMINAL_TICKET).ticket,
      });
      return true;
    }
    return false;
  }

  async #projects(
    method: string,
    req: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (method === "GET") {
      sendJson(
        response,
        200,
        this.#daemon.workspaces.list().map(projectFromWorkspace)
      );
      return true;
    }
    if (method !== "POST") {
      return false;
    }
    const body = asRecord(await readJsonBody(req));
    const path = asString(body?.cwd);
    if (!path) {
      throw new OmoCommandError("unknown_schema", "project cwd is required");
    }
    const workspace = this.#daemon.workspaces.register({
      name: asString(body?.name),
      path,
    });
    sendJson(response, 200, projectFromWorkspace(workspace));
    return true;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy session route compatibility
  async #sessions(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    response: ServerResponse,
    _principal: Principal
  ): Promise<boolean> {
    if (route.length === 1 && method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const list = await this.#listLegacySessions(cwd ?? undefined);
      sendJson(response, 200, list);
      return true;
    }
    if (route.length === 2 && route[1] === "all" && method === "GET") {
      sendJson(response, 200, await this.#listLegacySessions());
      return true;
    }
    if (method === "GET" && route.length === 2 && route[1] === "context") {
      const context = await this.#sessionContext({
        sessionPath: url.searchParams.get("path") ?? undefined,
      });
      const snapshot = await this.#history(context);
      const markdown = snapshot.items
        .map((item) => {
          const role = String(item.role ?? "message");
          return `### ${role}\n\n${String(item.text ?? item.output ?? "")}`;
        })
        .join("\n\n");
      sendJson(response, 200, { markdown });
      return true;
    }
    if (method === "GET" && route.length === 2 && route[1] === "details") {
      const cwd = url.searchParams.get("cwd") ?? "";
      const path = url.searchParams.get("path") ?? "";
      const workspace = this.#workspaceForPath(cwd);
      this.#actualSessionInWorkspace(path, workspace.workspaceId);
      const branch = await this.#gitOutput(
        ["branch", "--show-current"],
        workspace.path
      );
      // SQLite runtime usage is available to the execution side but the v1
      // details DTO only promises a number; keep the cost conservative until
      // the usage projection is exposed by AgentRuntime.
      sendJson(response, 200, {
        branch: branch.startsWith("fatal:") ? "" : branch.trim(),
        cost: 0,
      });
      return true;
    }
    if (method !== "POST" || route.length !== 2) {
      return false;
    }
    const body = asRecord(await readJsonBody(req));
    if (route[1] === "rename") {
      const sessionPath = asString(body?.path) ?? "";
      let actualId: string;
      try {
        actualId = this.#actualSessionId(sessionPath);
      } catch (error) {
        const local = await this.#findLocalSession(sessionPath);
        const workspace = local
          ? this.#workspaceForSessionCwd(local.cwd)
          : undefined;
        const imported =
          local && workspace
            ? await this.#importLocalSession(local, workspace)
            : undefined;
        if (!imported) {
          throw error;
        }
        actualId = imported;
      }
      const name = asString(body?.name)?.trim();
      if (!name) {
        throw new OmoCommandError("unknown_schema", "session name is required");
      }
      this.#daemon.catalog.rename(actualId, name);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route[1] === "context") {
      const context = await this.#sessionContext({
        sessionId: asString(body?.sessionId),
        sessionPath: asString(body?.path),
      });
      const snapshot = await this.#history(context);
      const markdown = snapshot.items
        .map((item) => {
          const role = String(item.role ?? "message");
          return `### ${role}\n\n${String(item.text ?? item.output ?? "")}`;
        })
        .join("\n\n");
      sendJson(response, 200, { markdown });
      return true;
    }
    if (route[1] === "details") {
      const cwd = asString(body?.cwd);
      const path = asString(body?.path);
      if (!(cwd && path)) {
        throw new OmoCommandError(
          "unknown_schema",
          "session details require cwd and path"
        );
      }
      const workspace = this.#workspaceForPath(cwd);
      this.#actualSessionInWorkspace(path, workspace.workspaceId);
      const branch = await this.#gitOutput(
        ["branch", "--show-current"],
        workspace.path
      );
      sendJson(response, 200, {
        branch: branch.startsWith("fatal:") ? "" : branch.trim(),
        cost: 0,
      });
      return true;
    }
    if (route[1] === "clone" || route[1] === "import") {
      const sourcePath = asString(body?.path) ?? asString(body?.sourcePath);
      if (!sourcePath) {
        throw new OmoCommandError(
          "unknown_schema",
          `legacy sessions/${route[1]} requires a source path`
        );
      }
      const actualSource =
        this.#aliases.get(sourcePath) ??
        (this.#daemon.catalog.get(sourcePath) ? sourcePath : undefined);
      const source = actualSource
        ? this.#daemon.catalog.get(actualSource)
        : undefined;
      const localSource = source
        ? undefined
        : await this.#findLocalSession(sourcePath);
      const { runtime } = this.#daemon;
      if (!(source || localSource)) {
        throw new OmoCommandError(
          "unknown_command",
          "source session is unknown"
        );
      }
      const sourceWorkspace = source
        ? this.#daemon.workspaces.get(source.workspaceId)
        : this.#workspaceForSessionCwd(localSource?.cwd ?? "");
      const destination =
        route[1] === "import"
          ? this.#workspaceForPath(asString(body?.cwd) ?? "")
          : sourceWorkspace;
      if (!destination) {
        throw new OmoCommandError(
          "unknown_workspace",
          "session workspace is missing"
        );
      }
      let sessionId: string;
      if (localSource) {
        const imported = await this.#importLocalSession(
          localSource,
          destination,
          true
        );
        if (!imported) {
          throw new OmoCommandError(
            "unknown_command",
            "the configured runtime cannot import local sessions"
          );
        }
        sessionId = imported;
      } else {
        if (!(runtime.forkSession && actualSource)) {
          throw new OmoCommandError(
            "unknown_command",
            "the configured runtime cannot fork sessions"
          );
        }
        sessionId = await runtime.forkSession(actualSource);
        this.#daemon.catalog.record({
          sessionId,
          workspaceId: destination.workspaceId,
        });
      }
      this.#aliases.set(sessionId, sessionId);
      sendJson(response, 200, { path: sessionId });
      return true;
    }
    return false;
  }

  #workspaceForSessionCwd(cwd: string): WorkspaceRecord | undefined {
    if (!cwd) {
      return undefined;
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolve(cwd));
    } catch {
      return undefined;
    }
    return [...this.#daemon.workspaces.list()]
      .sort((left, right) => right.path.length - left.path.length)
      .find((workspace) => isInside(workspace.path, canonical));
  }

  async #localSessionInfos(cwd?: string): Promise<readonly SessionInfo[]> {
    try {
      const sessions = cwd
        ? await SessionManager.list(cwd)
        : await SessionManager.listAll();
      return sessions.filter(
        (session) => this.#workspaceForSessionCwd(session.cwd) !== undefined
      );
    } catch {
      return [];
    }
  }

  async #findLocalSession(value: string): Promise<SessionInfo | undefined> {
    const sessions = await this.#localSessionInfos();
    const byId = sessions.find((session) => session.id === value);
    if (byId) {
      return byId;
    }
    let canonical: string | undefined;
    try {
      canonical = realpathSync(resolve(value));
    } catch {
      canonical = undefined;
    }
    if (!canonical) {
      return undefined;
    }
    let sessionRoot: string;
    try {
      sessionRoot = realpathSync(LEGACY_SESSION_ROOT);
    } catch {
      sessionRoot = resolve(LEGACY_SESSION_ROOT);
    }
    if (!isInside(sessionRoot, canonical)) {
      throw new OmoCommandError(
        "permission_denied",
        "session path is outside the local Pi session directory"
      );
    }
    return sessions.find((session) => {
      try {
        return realpathSync(session.path) === canonical;
      } catch {
        return false;
      }
    });
  }

  async #importLocalSession(
    info: SessionInfo,
    workspace: WorkspaceRecord,
    forceNewId = false
  ): Promise<string | undefined> {
    const { importSession: importSessionMethod } = this.#daemon.runtime;
    const importSession = importSessionMethod?.bind(this.#daemon.runtime);
    if (!importSession) {
      return undefined;
    }
    const existing = forceNewId ? undefined : this.#daemon.catalog.get(info.id);
    if (existing) {
      if (existing.workspaceId !== workspace.workspaceId) {
        throw new OmoCommandError(
          "permission_denied",
          "session belongs to another workspace"
        );
      }
      this.#aliases.set(info.path, existing.sessionId);
      return existing.sessionId;
    }
    const key = `${info.path}\u0000${workspace.workspaceId}`;
    if (!forceNewId) {
      const pending = this.#localImports.get(key);
      if (pending) {
        return pending;
      }
    }
    const operation = (async (): Promise<string> => {
      const manager = SessionManager.open(info.path);
      const messages = manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      const sessionId = await importSession({
        ...(forceNewId ? {} : { id: info.id }),
        messages,
        ...(info.name === undefined ? {} : { name: info.name }),
      });
      this.#daemon.catalog.record({
        createdAt: forceNewId
          ? new Date().toISOString()
          : info.created.toISOString(),
        name: info.name,
        sessionId,
        workspaceId: workspace.workspaceId,
      });
      if (!forceNewId) {
        this.#aliases.set(info.id, sessionId);
        this.#aliases.set(info.path, sessionId);
      }
      return sessionId;
    })();
    if (forceNewId) {
      return operation;
    }
    this.#localImports.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#localImports.get(key) === operation) {
        this.#localImports.delete(key);
      }
    }
  }

  async #syncLocalSessions(cwd?: string): Promise<readonly SessionInfo[]> {
    if (!this.#daemon.runtime.importSession) {
      return [];
    }
    const sessions = await this.#localSessionInfos(cwd);
    const imported: SessionInfo[] = [];
    for (const info of sessions) {
      const workspace = this.#workspaceForSessionCwd(info.cwd);
      if (!workspace) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: imports share one durable SQLite repository and must be serialized.
      const sessionId = await this.#importLocalSession(info, workspace);
      if (sessionId) {
        imported.push(info);
      }
    }
    return imported;
  }

  async #listLegacySessions(cwd?: string): Promise<LegacySession[]> {
    const localSessions = await this.#syncLocalSessions(cwd);
    const localById = new Map(
      localSessions.map((session) => [session.id, session])
    );
    const workspaceId = cwd
      ? this.#workspaceForPath(cwd).workspaceId
      : undefined;
    const summaries = new Map(
      (await this.#daemon.runtime.listSessions()).map((summary) => [
        summary.id,
        summary,
      ])
    );
    const sessions: LegacySession[] = [];
    for (const entry of this.#daemon.catalog
      .listAll()
      .filter(
        (candidate) => !workspaceId || candidate.workspaceId === workspaceId
      )) {
      const workspace = this.#daemon.workspaces.get(entry.workspaceId);
      if (!workspace) {
        continue;
      }
      const summary = summaries.get(entry.sessionId);
      const local = localById.get(entry.sessionId);
      const created = dateNumber(
        local?.created.getTime() ?? summary?.createdAt ?? entry.createdAt
      );
      let firstMessage = entry.name ?? local?.name ?? local?.firstMessage ?? "";
      let messageCount = local?.messageCount ?? 0;
      let modified = dateNumber(
        local?.modified.getTime() ?? summary?.createdAt ?? entry.createdAt
      );
      try {
        // biome-ignore lint/performance/noAwaitInLoops: session history is read in catalog order for stable sidebar results.
        const slot = await this.#daemon.supervisor.acquire(entry.sessionId);
        const snapshot = await this.#history({
          actualId: entry.sessionId,
          slot,
          workspace,
        });
        messageCount = snapshot.items.length;
        const first = snapshot.items.find((item) => item.role === "user");
        if (!(entry.name || local?.name) && first) {
          firstMessage = String(first.text ?? "").slice(0, 300);
        }
        modified = snapshot.items.reduce(
          (latest, item) => Math.max(latest, Number(item.timestamp) || latest),
          created
        );
      } catch {
        // A stale catalog row is still useful in the sidebar; the open route
        // reports the concrete runtime error when the user selects it.
      }
      sessions.push({
        created,
        cwd: workspace.path,
        firstMessage,
        id: entry.sessionId,
        messageCount,
        modified,
        name: entry.name,
        path: entry.sessionId,
      });
    }
    return sessions;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy pi route compatibility
  async #pi(
    method: string,
    route: string[],
    _url: URL,
    req: IncomingMessage,
    response: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    if (route.length === 2 && route[1] === "models" && method === "GET") {
      sendJson(response, 200, await this.#piModels());
      return true;
    }
    if (route.length === 2 && route[1] === "open" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const snapshot = await this.#history(context);
      const page = legacyPage(snapshot);
      const model = this.#modelForSnapshot(
        this.#daemon.supervisor.laneSnapshot(context.actualId)
      );
      const isStreaming =
        (await context.slot.session.inspect()).current !== null;
      sendJson(response, 200, {
        contextUsage: null,
        cursor: page.cursor,
        eventSequence: this.#eventSequences.get(context.actualId) ?? 0,
        hasMore: page.hasMore,
        isStreaming,
        messages: page.messages,
        model,
        outline: snapshot.metas,
        replayFromSequence: isStreaming ? 0 : undefined,
        sessionFile: context.actualId,
        sessionId: context.actualId,
        thinkingLevel: "max",
      });
      return true;
    }
    if (route.length === 2 && route[1] === "history" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const page = legacyPage(await this.#history(context), body?.before);
      sendJson(response, 200, page);
      return true;
    }
    if (route.length === 2 && route[1] === "sync" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const snapshot = await this.#history(context);
      const knownTurns = Math.max(0, Number(body?.turnCount) || 0);
      const knownTail = Math.max(0, Number(body?.tailItemCount) || 0);
      const totalTurns = snapshot.turnStarts.length;
      let fromTurn = -1;
      if (totalTurns > knownTurns) {
        fromTurn = knownTurns;
      } else if (totalTurns > 0 && totalTurns === knownTurns) {
        const lastStart = snapshot.turnStarts[totalTurns - 1];
        if (snapshot.items.length - lastStart > knownTail) {
          fromTurn = totalTurns - 1;
        }
      }
      sendJson(response, 200, {
        fromTurn,
        messages:
          fromTurn >= 0
            ? snapshot.items.slice(
                snapshot.turnStarts[fromTurn] ?? snapshot.items.length
              )
            : [],
        metas: snapshot.metas,
        totalTurns,
      });
      return true;
    }
    if (route.length === 2 && route[1] === "prompt" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const artifactIds = await this.#storeImages(body?.images);
      const requestId = asString(body?.requestId) ?? randomUUID();
      const prompt = asString(body?.message)?.trim();
      if (!(prompt || artifactIds.length)) {
        throw new OmoCommandError("unknown_schema", "prompt is required");
      }
      const commandId = `legacy_${context.actualId}_${requestId}`;
      const receipt = this.#daemon.service.submit(
        {
          clientMutationId: `legacy_mutation_${requestId}`,
          commandId,
          kind: "prompt",
          payload: {
            ...(artifactIds.length ? { artifactIds } : {}),
            prompt: prompt || "Please inspect the attached image.",
          },
          scope: {
            laneId: "main",
            sessionId: context.actualId,
            workspaceId: context.workspace.workspaceId,
          },
        },
        principal
      );
      sendJson(response, 202, {
        operationId: receipt.operationId,
        sessionFile: context.actualId,
        sessionId: context.actualId,
      });
      return true;
    }
    if (route.length === 2 && route[1] === "abort" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const { current } = await context.slot.session.inspect();
      if (current) {
        await this.#submitLegacyCommand(
          "operation.abort",
          { operationId: current.operationId },
          context.workspace.workspaceId,
          principal,
          context.actualId
        );
      }
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route.length === 2 && route[1] === "model" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const provider = asString(body?.provider);
      const modelId = asString(body?.modelId);
      const model = this.#daemon.runtime
        .listModels()
        .find((item) => item.provider === provider && item.modelId === modelId);
      if (!(model && provider && modelId)) {
        throw new OmoCommandError("unknown_command", "model is not available");
      }
      await this.#submitLegacyCommand(
        "session.configure",
        { model: { modelId, provider } },
        context.workspace.workspaceId,
        principal,
        context.actualId
      );
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route.length === 2 && route[1] === "thinking" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const level = asString(body?.level);
      if (!level) {
        throw new OmoCommandError(
          "unknown_schema",
          "thinking level is required"
        );
      }
      await this.#submitLegacyCommand(
        "session.configure",
        { thinkingLevel: level },
        context.workspace.workspaceId,
        principal,
        context.actualId
      );
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route.length === 2 && route[1] === "commands" && method === "POST") {
      sendJson(response, 200, []);
      return true;
    }
    if (
      route.length === 2 &&
      route[1] === "context-usage" &&
      method === "POST"
    ) {
      sendJson(response, 200, null);
      return true;
    }
    if (
      route.length === 2 &&
      route[1] === "context-details" &&
      method === "POST"
    ) {
      sendJson(response, 200, {
        extensions: [],
        injectedMessages: [],
        resources: {
          appendSystemPrompt: [],
          contextFiles: [],
          skills: [],
        },
        stats: {
          cost: 0,
          tokens: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            total: 0,
          },
          toolCalls: 0,
          totalMessages: 0,
        },
        systemPrompt: "You are a coding assistant.",
        tools: [],
      });
      return true;
    }
    if (route.length === 2 && route[1] === "branch" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const context = await this.#sessionContext(body);
      const entryId = asString(body?.entryId);
      if (!(entryId && context.slot.session.navigateTree)) {
        throw new OmoCommandError(
          "unknown_schema",
          "branch requires an entry id"
        );
      }
      const result = await context.slot.session.navigateTree(entryId);
      if (result.cancelled) {
        sendJson(response, 200, { cancelled: true });
        return true;
      }
      const snapshot = await this.#history(context);
      const page = legacyPage(snapshot);
      sendJson(response, 200, {
        ...page,
        cancelled: false,
        editorText: "",
        outline: snapshot.metas,
      });
      return true;
    }
    return false;
  }

  #storeImages(value: unknown): string[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new OmoCommandError("unknown_schema", "images must be an array");
    }
    if (value.length > 8) {
      throw new OmoCommandError("quota_exceeded", "too many image attachments");
    }
    const ids: string[] = [];
    for (const item of value) {
      const image = asRecord(item);
      const data = asString(image?.data);
      const mime = asString(image?.mimeType);
      if (!(data && mime?.startsWith("image/"))) {
        throw new OmoCommandError("unknown_schema", "invalid image attachment");
      }
      if (data.length > 8_000_000) {
        throw new OmoCommandError(
          "quota_exceeded",
          "image attachment is too large"
        );
      }
      const bytes = Buffer.from(data, "base64");
      const artifact = this.#daemon.artifacts.put(bytes, { mime });
      ids.push(artifact.artifactId);
    }
    return ids;
  }

  async #piModels(): Promise<JsonRecord[]> {
    const settings = readLegacySettings();
    const models = this.#daemon.runtime.listAvailableModels
      ? await this.#daemon.runtime.listAvailableModels()
      : this.#daemon.runtime.listModels();
    return models.map((model) => ({
      contextWindow: 0,
      enabled: legacyModelEnabled(settings, model.provider, model.modelId),
      id: model.modelId,
      name: model.name ?? model.modelId,
      provider: model.provider,
      reasoning: true,
      thinkingLevels: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    }));
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy file route compatibility
  async #files(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    response: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    if (
      (method === "POST" || method === "PUT") &&
      route.length === 2 &&
      route[1] === "content"
    ) {
      const body = asRecord(await readJsonBody(req));
      const filePath = asString(body?.path);
      if (!filePath) {
        throw new OmoCommandError("unknown_schema", "file path is required");
      }
      const workspace = this.#workspaceForWritePath(filePath);
      const relativePath = relative(workspace.path, resolve(filePath));
      if (!relativePath || relativePath.startsWith("..")) {
        throw new OmoCommandError(
          "permission_denied",
          "file path escapes workspace"
        );
      }
      const contentText =
        asString(body?.contentText) ?? asString(body?.content);
      const contentBase64 = asString(body?.contentBase64);
      if ((contentText === undefined) === (contentBase64 === undefined)) {
        throw new OmoCommandError(
          "unknown_schema",
          "file content requires exactly one text or base64 value"
        );
      }
      const result = await this.#submitLegacyCommand(
        "file.save",
        {
          ...(contentBase64 === undefined
            ? { contentText }
            : { contentBase64 }),
          ...(asString(body?.baseHash)
            ? { baseHash: asString(body?.baseHash) }
            : {}),
          path: relativePath,
        },
        workspace.workspaceId,
        principal
      );
      sendJson(response, 200, result);
      return true;
    }
    if (method === "GET" && route.length === 1) {
      const directory = this.#rootPath(url.searchParams.get("path"));
      const entries = await readdir(directory, { withFileTypes: true });
      sendJson(
        response,
        200,
        entries
          .filter(
            (entry) =>
              !entry.name.startsWith(".") && entry.name !== "node_modules"
          )
          .map((entry) => ({ dir: entry.isDirectory(), name: entry.name }))
          .sort(
            (left, right) =>
              Number(right.dir) - Number(left.dir) ||
              left.name.localeCompare(right.name)
          )
      );
      return true;
    }
    if (method === "GET" && route.length === 2 && route[1] === "content") {
      const filePath = this.#rootPath(url.searchParams.get("path"));
      const isBinary = url.searchParams.get("binary") === "true";
      const extension = extname(filePath).toLowerCase();
      const mime = IMAGE_MIME[extension];
      const fileStat = await stat(filePath);
      const maxBytes =
        isBinary && mime ? LEGACY_IMAGE_LIMIT : LEGACY_TEXT_LIMIT;
      if (fileStat.size > maxBytes) {
        throw new OmoCommandError("quota_exceeded", "file is too large");
      }
      const bytes = await readFile(filePath);
      if (isBinary && mime) {
        sendJson(response, 200, {
          data: bytes.toString("base64"),
          mimeType: mime,
        });
      } else {
        sendJson(response, 200, { content: bytes.toString("utf8") });
      }
      return true;
    }
    return false;
  }

  async #git(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (route.length === 2 && route[1] === "branch" && method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const cwd = this.#workspaceForPath(asString(body?.cwd) ?? "").path;
      const name = asString(body?.name) ?? "";
      const output = await this.#gitOutput(["checkout", "-b", name], cwd);
      const failed = GIT_FAILURE_PATTERN.test(output);
      sendJson(response, failed ? 400 : 200, { ok: !failed, output });
      return true;
    }
    if (method !== "GET" || route.length !== 2) {
      return false;
    }
    const cwd = this.#workspaceForPath(url.searchParams.get("cwd") ?? "").path;
    if (route[1] === "status") {
      sendJson(response, 200, {
        output: await this.#gitOutput(["status", "--porcelain"], cwd),
      });
      return true;
    }
    if (route[1] === "diff") {
      sendJson(response, 200, {
        output: await this.#gitOutput(
          ["diff", "HEAD", "--", url.searchParams.get("file") ?? ""],
          cwd
        ),
      });
      return true;
    }
    if (route[1] === "branches") {
      const output = await this.#gitOutput(
        ["branch", "--format=%(refname:short)|%(HEAD)"],
        cwd
      );
      const branches = output.startsWith("fatal:")
        ? []
        : output
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [name, head] = line.split("|");
              return { current: head === "*", name };
            });
      sendJson(response, 200, branches);
      return true;
    }
    return false;
  }

  async #gitOutput(args: string[], cwd: string): Promise<string> {
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return String(result.stdout);
    } catch (cause) {
      const error = asRecord(cause);
      return String(error?.stderr ?? error?.message ?? cause);
    }
  }

  async #quotas(
    method: string,
    url: URL,
    response: ServerResponse
  ): Promise<boolean> {
    if (method !== "GET") {
      return false;
    }
    const { providers } = this.#daemon.runtime;
    const fetchQuotas = getLegacyQuotaFetcher();
    if (!(providers && fetchQuotas)) {
      sendJson(response, 200, { installed: false, items: [] });
      return true;
    }
    const result = await fetchQuotas(
      {
        runtime: async () => ({
          getAuth: providers.getAuth.bind(providers),
        }),
      },
      LEGACY_AGENT_DIR,
      url.searchParams.get("force") === "true",
      legacyAuthPath()
    );
    sendJson(response, 200, result);
    return true;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy provider route compatibility
  async #providers(
    method: string,
    route: string[],
    req: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (route.length === 1 && method === "GET") {
      if (this.#daemon.runtime.providers) {
        sendJson(response, 200, await this.#daemon.runtime.providers.list());
        return true;
      }
      const providers = new Map<string, JsonRecord>();
      for (const model of this.#daemon.runtime.listModels()) {
        providers.set(model.provider, {
          authType: undefined,
          connected: true,
          hasApiKey: false,
          hasOAuth: false,
          id: model.provider,
          name: model.provider,
          subscription: false,
        });
      }
      sendJson(response, 200, [...providers.values()]);
      return true;
    }
    if (route.length !== 2 || method !== "POST") {
      return false;
    }
    const body = asRecord(await readJsonBody(req));
    const [, action] = route;
    const { providers } = this.#daemon.runtime;
    if (action === "login") {
      const providerId = asString(body?.providerId);
      const type = asString(body?.type);
      if (
        !(providerId && (type === "api_key" || type === "oauth") && providers)
      ) {
        throw new OmoCommandError(
          "unknown_command",
          "provider authentication is unavailable"
        );
      }
      await providers.login(providerId, type, {
        notify: (event) =>
          this.#broadcast("__providers", {
            event,
            kind: "notify",
            providerId,
          }),
        prompt: (prompt) => {
          const requestId = randomUUID();
          this.#broadcast("__providers", {
            kind: "prompt",
            prompt: {
              ...prompt,
              signal: undefined,
            },
            providerId,
            requestId,
          });
          return new Promise<string>((resolvePromise, rejectPromise) => {
            this.#authPrompts.set(requestId, {
              reject: rejectPromise,
              resolve: resolvePromise,
            });
          });
        },
      });
      sendJson(response, 200, true);
      return true;
    }
    if (action === "respond") {
      const requestId = asString(body?.requestId);
      const prompt = requestId ? this.#authPrompts.get(requestId) : undefined;
      if (!prompt) {
        sendJson(response, 200, false);
        return true;
      }
      this.#authPrompts.delete(requestId as string);
      prompt.resolve(String(body?.value ?? ""));
      sendJson(response, 200, true);
      return true;
    }
    if (action === "cancel") {
      const requestId = asString(body?.requestId);
      const prompt = requestId ? this.#authPrompts.get(requestId) : undefined;
      if (!prompt) {
        sendJson(response, 200, false);
        return true;
      }
      this.#authPrompts.delete(requestId as string);
      prompt.reject(new Error("Authentication cancelled"));
      sendJson(response, 200, true);
      return true;
    }
    if (action === "logout") {
      const providerId = asString(body?.providerId);
      if (!(providerId && providers)) {
        throw new OmoCommandError(
          "unknown_command",
          "provider authentication is unavailable"
        );
      }
      await providers.logout(providerId);
      sendJson(response, 200, true);
      return true;
    }
    return false;
  }

  async #models(
    method: string,
    req: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (method === "GET") {
      sendJson(response, 200, await this.#piModels());
      return true;
    }
    if (method === "POST") {
      const body = asRecord(await readJsonBody(req));
      if (Array.isArray(body?.enabled)) {
        const available = this.#daemon.runtime.listAvailableModels
          ? await this.#daemon.runtime.listAvailableModels()
          : this.#daemon.runtime.listModels();
        const enabled = new Set(
          body.enabled.filter(
            (value): value is string => typeof value === "string"
          )
        );
        const allEnabled = available.every((model) =>
          enabled.has(legacyModelKey(model.provider, model.modelId))
        );
        const settings = readLegacySettings();
        settings.enabledModels = allEnabled
          ? undefined
          : available
              .filter((model) =>
                enabled.has(legacyModelKey(model.provider, model.modelId))
              )
              .map((model) => legacyModelKey(model.provider, model.modelId));
        if (!allEnabled && enabled.size === 0) {
          settings.enabledModels = ["__omo_no_models__"];
        }
        writeLegacySettings(settings);
      }
      sendJson(response, 200, await this.#piModels());
      return true;
    }
    return false;
  }

  async #packages(
    method: string,
    route: string[],
    req: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (method === "GET" && route.length === 1) {
      sendJson(response, 200, legacyPackages());
      return true;
    }
    if (method === "POST" && route.length === 2) {
      const body = asRecord(await readJsonBody(req));
      const source = asString(body?.source)?.trim();
      if (!source) {
        throw new OmoCommandError(
          "unknown_schema",
          "package source is required"
        );
      }
      let packages: LegacyPackageInfo[];
      if (route[1] === "install") {
        packages = await installLegacyPackage(source);
      } else if (route[1] === "remove") {
        packages = removeLegacyPackage(source);
      } else {
        return false;
      }
      sendJson(response, 200, packages);
      return true;
    }
    return false;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy session alias resolution
  async #sessionContext(input: unknown): Promise<LegacySessionContext> {
    const body = asRecord(input);
    const requested = asString(body?.sessionId);
    const sessionPath = asString(body?.sessionPath);
    const candidates = [requested, sessionPath].filter(
      (value): value is string => !!value
    );
    let actualId: string | undefined;
    for (const candidate of candidates) {
      actualId =
        this.#aliases.get(candidate) ??
        (this.#daemon.catalog.get(candidate) ? candidate : undefined);
      if (actualId) {
        break;
      }
    }
    if (!actualId) {
      const localSessions = await Promise.all(
        candidates.map((candidate) => this.#findLocalSession(candidate))
      );
      const local = localSessions.find((candidate) => candidate !== undefined);
      const localWorkspace = local
        ? this.#workspaceForSessionCwd(local.cwd)
        : undefined;
      if (local && localWorkspace) {
        const requestedCwd = asString(body?.cwd);
        const workspace = requestedCwd
          ? this.#workspaceForPath(requestedCwd)
          : localWorkspace;
        if (workspace.workspaceId !== localWorkspace.workspaceId) {
          throw new OmoCommandError(
            "permission_denied",
            "session belongs to another workspace"
          );
        }
        actualId = await this.#importLocalSession(local, workspace);
        if (!actualId) {
          throw new OmoCommandError(
            "unknown_command",
            "the configured runtime cannot import local sessions"
          );
        }
      }
    }
    if (actualId) {
      const catalog = this.#daemon.catalog.get(actualId);
      if (!catalog) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown session ${actualId}`
        );
      }
      const workspace = this.#daemon.workspaces.get(catalog.workspaceId);
      if (!workspace) {
        throw new OmoCommandError(
          "unknown_workspace",
          "session workspace is missing"
        );
      }
      const cwd = asString(body?.cwd);
      if (cwd) {
        const requestedWorkspace = this.#workspaceForPath(cwd);
        if (requestedWorkspace.workspaceId !== workspace.workspaceId) {
          throw new OmoCommandError(
            "permission_denied",
            "session belongs to another workspace"
          );
        }
      }
      const slot = await this.#daemon.supervisor.acquire(actualId);
      if (requested) {
        this.#aliases.set(requested, actualId);
      }
      if (sessionPath) {
        this.#aliases.set(sessionPath, actualId);
      }
      return { actualId, slot, workspace };
    }
    const requestedCwd = asString(body?.cwd);
    if (!(requested && requestedCwd)) {
      throw new OmoCommandError(
        "unknown_schema",
        "session id and cwd are required"
      );
    }
    const workspace = this.#workspaceForPath(requestedCwd);
    const slot = await this.#daemon.supervisor.create();
    const catalog = this.#daemon.catalog.record({
      sessionId: slot.sessionId,
      workspaceId: workspace.workspaceId,
    });
    this.#aliases.set(requested, catalog.sessionId);
    if (sessionPath) {
      this.#aliases.set(sessionPath, catalog.sessionId);
    }
    return { actualId: catalog.sessionId, slot, workspace };
  }

  #actualSessionId(value: string): string {
    if (!value) {
      throw new OmoCommandError("unknown_schema", "session id is required");
    }
    const actual =
      this.#aliases.get(value) ??
      (this.#daemon.catalog.get(value) ? value : undefined);
    if (!(actual && this.#daemon.catalog.get(actual))) {
      throw new OmoCommandError("unknown_command", `unknown session ${value}`);
    }
    return actual;
  }

  #actualSessionInWorkspace(value: string, workspaceId: string): string {
    const actual = this.#actualSessionId(value);
    const entry = this.#daemon.catalog.get(actual);
    if (entry?.workspaceId !== workspaceId) {
      throw new OmoCommandError(
        "permission_denied",
        "session belongs to another workspace"
      );
    }
    return actual;
  }

  #workspaceForPath(value: string): WorkspaceRecord {
    if (!value) {
      throw new OmoCommandError("unknown_schema", "workspace path is required");
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolve(value));
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards cause to super
      throw new OmoCommandError(
        "unknown_workspace",
        `path does not exist: ${value}`,
        false,
        {
          cause,
        }
      );
    }
    const workspace = [...this.#daemon.workspaces.list()]
      .sort((left, right) => right.path.length - left.path.length)
      .find((item) => isInside(item.path, canonical));
    if (workspace) {
      return workspace;
    }
    if (
      this.#daemon.workspaces.roots().some((root) => isInside(root, canonical))
    ) {
      throw new OmoCommandError(
        "unknown_workspace",
        `path is allowed but not registered as a workspace: ${canonical}`
      );
    }
    throw new OmoCommandError(
      "permission_denied",
      `path is outside workspace roots: ${value}`
    );
  }

  #workspaceForWritePath(value: string): WorkspaceRecord {
    if (!value) {
      throw new OmoCommandError("unknown_schema", "file path is required");
    }
    const target = resolve(value);
    let canonical: string;
    try {
      canonical = realpathSync(target);
    } catch (cause) {
      try {
        canonical = resolve(realpathSync(dirname(target)), basename(target));
      } catch {
        // biome-ignore lint/style/useErrorCause: OmoCommandError forwards cause to super
        throw new OmoCommandError(
          "unknown_command",
          `parent directory does not exist: ${value}`,
          false,
          { cause }
        );
      }
    }
    if (
      !this.#daemon.workspaces.roots().some((root) => isInside(root, canonical))
    ) {
      throw new OmoCommandError(
        "permission_denied",
        `path is outside workspace roots: ${value}`
      );
    }
    const workspace = [...this.#daemon.workspaces.list()]
      .sort((left, right) => right.path.length - left.path.length)
      .find((item) => isInside(item.path, canonical));
    if (!workspace) {
      throw new OmoCommandError(
        "unknown_workspace",
        `path is allowed but not registered as a workspace: ${value}`
      );
    }
    return workspace;
  }

  #rootPath(value: string | null): string {
    if (!value) {
      throw new OmoCommandError("unknown_schema", "path is required");
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolve(value));
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards cause to super
      throw new OmoCommandError(
        "unknown_command",
        `path does not exist: ${value}`,
        false,
        {
          cause,
        }
      );
    }
    if (
      !this.#daemon.workspaces.roots().some((root) => isInside(root, canonical))
    ) {
      throw new OmoCommandError(
        "permission_denied",
        `path is outside workspace roots: ${value}`
      );
    }
    return canonical;
  }

  async #history(context: LegacySessionContext): Promise<LegacySnapshot> {
    const page = await context.slot.session.readHistory({
      limit: LEGACY_HISTORY_LIMIT,
    });
    const items = this.#toLegacyMessages(page.entries);
    const turnStarts: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (index === 0 || items[index].role === "user") {
        turnStarts.push(index);
      }
    }
    const metas = turnStarts.map((messageIndex, absoluteIndex) => {
      const message = items[messageIndex];
      const text = message?.role === "user" ? String(message.text ?? "") : "";
      return {
        absoluteIndex,
        id:
          message?.role === "user"
            ? String(message.id)
            : `${message?.id}:orphan`,
        userPreview: text.replace(/\s+/g, " ").trim().slice(0, 300),
      };
    });
    return { items, metas, turnStarts };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: message projection preserves the v1 display contract
  #toLegacyMessages(entries: readonly RuntimeHistoryEntry[]): LegacyMessage[] {
    const items: LegacyMessage[] = [];
    const tools = new Map<string, LegacyMessage>();
    for (const entry of entries) {
      const body = asRecord(entry.body) ?? {};
      const role = asString(body.role);
      if (!role) {
        continue;
      }
      const timestamp = timestampOf(body.timestamp, entry.timestamp);
      if (role === "user") {
        const parts = contentParts(body.content);
        const text = clip(textFromContent(body.content), 80_000);
        const images = parts.filter((part) => part.type === "image");
        if (text || images.length) {
          items.push({
            ...(images.length ? { images } : {}),
            id: entry.id,
            role,
            sessionEntryId: entry.id,
            text,
            timestamp,
          });
        }
        continue;
      }
      if (role === "assistant") {
        let text = "";
        for (const part of contentParts(body.content)) {
          if (part.type === "text") {
            text += String(part.text ?? "");
          } else if (part.type === "thinking") {
            if (text) {
              items.push({
                id: `${entry.id}:text:${items.length}`,
                role: "assistant",
                text: clip(text, 100_000),
                timestamp,
              });
              text = "";
            }
            items.push({
              id: `${entry.id}:thinking:${items.length}`,
              role: "thinking",
              status: "done",
              text: clip(String(part.thinking ?? ""), 40_000),
            });
          } else if (part.type === "toolCall") {
            if (text) {
              items.push({
                id: `${entry.id}:text:${items.length}`,
                role: "assistant",
                text: clip(text, 100_000),
                timestamp,
              });
              text = "";
            }
            const id = String(part.id ?? `${entry.id}:tool:${items.length}`);
            const tool: LegacyMessage = {
              id,
              input: clip(stringify(part.arguments), 8000),
              role: "tool",
              status: "running",
              toolName: String(part.name ?? "tool"),
            };
            tools.set(id, tool);
            items.push(tool);
          }
        }
        if (text) {
          items.push({
            id: `${entry.id}:text:${items.length}`,
            role: "assistant",
            text: clip(text, 100_000),
            timestamp,
          });
        }
        if (body.stopReason === "error") {
          items.push({
            id: `${entry.id}:error`,
            role: "error",
            text: clip(String(body.errorMessage ?? "Unknown error"), 8000),
            timestamp,
          });
        }
        continue;
      }
      if (role === "toolResult") {
        const toolCallId = String(body.toolCallId ?? "");
        const tool = tools.get(toolCallId);
        if (tool) {
          tool.output = clip(textFromContent(body.content), 16_000);
          tool.status = body.isError ? "error" : "done";
        } else {
          items.push({
            id: toolCallId || `${entry.id}:tool`,
            output: clip(textFromContent(body.content), 16_000),
            role: "tool",
            status: body.isError ? "error" : "done",
            toolName: String(body.toolName ?? "tool"),
          });
        }
      }
    }
    for (const item of items) {
      if (item.role === "tool" && item.status === "running") {
        item.output =
          "Interrupted: the agent stopped before returning a tool result.";
        item.status = "error";
      }
    }
    return items;
  }

  #modelForSnapshot(
    snapshot: RuntimeLaneSnapshot | undefined
  ): JsonRecord | null {
    const model = snapshot?.model;
    return model
      ? { id: model.modelId, name: model.modelId, provider: model.provider }
      : null;
  }
}
