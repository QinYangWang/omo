import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createTlsServer,
  type Server as TlsServer,
} from "node:https";
import { extname, join, resolve } from "node:path";
import type { Principal } from "@omo/control-plane/inbox";
import { type CommandScope, CommandScopeSchema } from "@omo/protocol/command";
import {
  OmoCommandError,
  type OmoError,
  type OmoErrorCode,
} from "@omo/protocol/errors";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Daemon } from "./daemon.ts";
import { readWorkspaceFile } from "./files.ts";
import { LegacyHttpAdapter } from "./legacy-http.ts";
import { SyncHub } from "./sync.ts";
import { TicketStore } from "./tickets.ts";
import { isInside } from "./workspaces.ts";

/**
 * HTTP network entry of the daemon (plan §6.2, §13 P1).
 *
 * Covers the P1 surface: pairing / revocation, durable command submit +
 * query, pending interaction listing + first-writer-wins answers. The WSS
 * multiplex / snapshot / cursor sync protocol is a P2 deliverable and is
 * deliberately NOT stubbed here (§13 phase boundaries).
 *
 * Security defaults (§10.1/§10.2): loopback binding is chosen by the caller;
 * every /v1 route except /v1/hello and /v1/pairing requires a device bearer
 * credential; request bodies are capped at 1 MiB; unknown control errors are
 * rejected, never degraded (§6.3).
 */

const MAX_BODY_BYTES = 1_048_576;
/** Artifact uploads get their own, larger budget (§8.3.6 output budgets). */
const MAX_ARTIFACT_BYTES = 67_108_864;
/** File reads are capped; larger content belongs in artifacts (§5.3). */
const MAX_FILE_READ_BYTES = 4_194_304;

const SubmitCommandBodySchema = Type.Object({
  clientMutationId: Type.String({ minLength: 1 }),
  commandId: Type.String({ minLength: 1 }),
  expectedOperationId: Type.Optional(Type.String({ minLength: 1 })),
  expectedRevision: Type.Optional(Type.String({ minLength: 1 })),
  issuedAt: Type.Optional(Type.String({ format: "date-time" })),
  kind: Type.String({ minLength: 1 }),
  payload: Type.Unknown(),
  scope: CommandScopeSchema,
});
const PairingBodySchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
});
const InteractionBodySchema = Type.Object({
  deadline: Type.Optional(Type.String({ format: "date-time" })),
  eligiblePrincipals: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
  }),
  interactionId: Type.Optional(Type.String({ minLength: 1 })),
  invocationId: Type.String({ minLength: 1 }),
  pluginGeneration: Type.Optional(Type.String({ minLength: 1 })),
  request: Type.Unknown(),
  schemaVersion: Type.Integer({ minimum: 1 }),
  scope: CommandScopeSchema,
});
const AnswerBodySchema = Type.Object({
  answer: Type.Unknown(),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});
const DraftBodySchema = Type.Object({
  body: Type.String(),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
});
const WorkspaceBodySchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
});

const submitCheck = Compile(SubmitCommandBodySchema);
const pairingCheck = Compile(PairingBodySchema);
const interactionCheck = Compile(InteractionBodySchema);
const answerCheck = Compile(AnswerBodySchema);
const workspaceCheck = Compile(WorkspaceBodySchema);
const draftCheck = Compile(DraftBodySchema);

const STATUS_BY_CODE: Record<OmoErrorCode, number> = {
  already_answered: 409,
  daemon_offline: 503,
  duplicate_payload_mismatch: 409,
  internal: 500,
  operation_mismatch: 409,
  payload_schema_unsupported: 400,
  permission_denied: 403,
  quota_exceeded: 429,
  reset_required: 409,
  revision_mismatch: 409,
  storage_unavailable: 503,
  unauthenticated: 401,
  unknown_command: 404,
  unknown_interaction: 404,
  unknown_schema: 400,
  unknown_workspace: 404,
  writer_conflict: 409,
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-length": Buffer.byteLength(data),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(data);
};

const sendError = (res: ServerResponse, error: OmoError): void => {
  sendJson(res, STATUS_BY_CODE[error.code] ?? 500, { error });
};

const toOmoError = (error: unknown): OmoError => {
  if (error instanceof OmoCommandError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

const tryParseJson = (
  text: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const bytes = await readRawBody(req, MAX_BODY_BYTES);
  if (bytes.length === 0) {
    return {};
  }
  const parsed = tryParseJson(bytes.toString("utf8"));
  if (!parsed.ok) {
    throw new OmoCommandError("unknown_schema", "request body must be JSON");
  }
  return parsed.value;
};

/** Raw upload reader (artifacts); capped independently from JSON bodies. */
const readRawBody = async (
  req: IncomingMessage,
  limit: number
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > limit) {
      throw new OmoCommandError(
        "quota_exceeded",
        `request body exceeds ${limit} bytes`
      );
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
};

const checked = <T>(
  check: { Check: (value: unknown) => boolean },
  body: unknown,
  what: string
): T => {
  if (!check.Check(body)) {
    throw new OmoCommandError(
      "unknown_schema",
      `request body failed the ${what} schema`
    );
  }
  return body as T;
};

const MIME_BY_EXT: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const scopeFromQuery = (query: URLSearchParams): CommandScope | undefined => {
  const workspaceId = query.get("workspaceId");
  if (!workspaceId) {
    return undefined;
  }
  const scope: Record<string, string> = { workspaceId };
  const sessionId = query.get("sessionId");
  const laneId = query.get("laneId");
  if (sessionId) {
    scope.sessionId = sessionId;
  }
  if (laneId) {
    scope.laneId = laneId;
  }
  return scope as CommandScope;
};

/** Maps a lost interaction answer race to a stable wire code (§7.6). */
const ANSWER_ERROR_CODES: Record<string, OmoErrorCode> = {
  already_answered: "already_answered",
  not_eligible: "permission_denied",
  not_pending: "operation_mismatch",
  revision_mismatch: "revision_mismatch",
  unknown_interaction: "unknown_interaction",
};

export class DaemonHttpServer {
  readonly #daemon: Daemon;
  readonly #server: Server | TlsServer;
  readonly #sync: SyncHub;
  readonly #tickets = new TicketStore();
  readonly #legacy: LegacyHttpAdapter;
  readonly #webRoot?: string;
  readonly #webMode: "v1" | "v2";

  constructor(
    daemon: Daemon,
    options?: {
      /** TLS material for server deployments (plan §4.2: 非 loopback 必须显式开 TLS). */
      readonly tls?: { readonly cert: string; readonly key: string };
      /** Serve the built web bundle (SPA) for non-/v1 paths (v1 OMO_WEB_ROOT parity). */
      readonly webRoot?: string;
      /** Select the original v1 shell or the native v2 shell for the bundle. */
      readonly webMode?: "v1" | "v2";
    }
  ) {
    this.#daemon = daemon;
    this.#webMode = options?.webMode ?? "v2";
    this.#webRoot = options?.webRoot;
    this.#legacy = new LegacyHttpAdapter(daemon);
    this.#sync = new SyncHub(daemon);
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      this.#route(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.end();
        } else {
          sendError(res, toOmoError(error));
        }
      });
    };
    this.#server = options?.tls
      ? createTlsServer(
          { cert: options.tls.cert, key: options.tls.key },
          handler
        )
      : createServer(handler);
    // One WSS multiplex per daemon (plan §6.2): /v1/sync upgrades with a
    // one-time ticket obtained over authenticated HTTPS. The legacy terminal
    // stream is attached to the same HTTP/TLS server at /api/v1.
    this.#legacy.attach(this.#server, this.#tickets);
    this.#sync.attach(this.#server, this.#tickets);
  }

  get syncHub(): SyncHub {
    return this.#sync;
  }

  #authenticate(req: IncomingMessage): Principal {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new OmoCommandError(
        "unauthenticated",
        "missing device bearer credential"
      );
    }
    const principal = this.#daemon.devices.authenticate(header.slice(7));
    if (!principal) {
      throw new OmoCommandError(
        "unauthenticated",
        "unknown or revoked device credential"
      );
    }
    return principal;
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const { origin } = req.headers;
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    res.setHeader(
      "access-control-allow-headers",
      "Authorization, Content-Type, Last-Event-ID"
    );
    res.setHeader(
      "access-control-allow-methods",
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "api" && segments[1] === "v1") {
      const principal = this.#authenticate(req);
      const handled = await this.#legacy.handle(
        method,
        segments.slice(2),
        url,
        req,
        res,
        principal
      );
      if (handled) {
        return;
      }
      throw new OmoCommandError(
        "unknown_command",
        `unknown legacy route ${method} ${url.pathname}`
      );
    }
    if (segments[0] !== "v1") {
      // Non-protocol paths: the optional web bundle (SPA) when a web root is
      // configured (server deployment form, plan §4.2). Never authed — the
      // app shell is public; all data flows through authenticated /v1.
      if ((method === "GET" || method === "HEAD") && this.#webRoot) {
        this.#serveWeb(url.pathname, res, method === "HEAD");
        return;
      }
      throw new OmoCommandError(
        "unknown_command",
        `unknown route ${url.pathname}`
      );
    }
    const route = segments.slice(1);

    if (await this.#routePublic(method, route, req, res)) {
      return;
    }
    const principal = this.#authenticate(req);
    if (this.#routeDevices(method, route, res)) {
      return;
    }
    if (await this.#routeWorkspaces(method, route, url, req, res)) {
      return;
    }
    if (await this.#routeArtifacts(method, route, req, res)) {
      return;
    }
    if (await this.#routeCommands(method, route, url, req, res, principal)) {
      return;
    }
    if (await this.#routeSessionData(method, route, url, req, res, principal)) {
      return;
    }
    if (
      await this.#routeInteractions(method, route, url, req, res, principal)
    ) {
      return;
    }
    throw new OmoCommandError(
      "unknown_command",
      `unknown route ${method} ${url.pathname}`
    );
  }

  async #routePublic(
    method: string,
    route: string[],
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (method === "GET" && route.length === 1 && route[0] === "hello") {
      sendJson(res, 200, {
        durability: this.#daemon.durability,
        identity: this.#daemon.identity,
      });
      return true;
    }
    if (method === "POST" && route.length === 1 && route[0] === "pairing") {
      const body = checked<Static<typeof PairingBodySchema>>(
        pairingCheck,
        await readBody(req),
        "pairing"
      );
      const paired = this.#daemon.devices.pair(
        body.code,
        this.#daemon.pairingCode,
        body.name
      );
      sendJson(res, 201, paired);
      return true;
    }
    return false;
  }

  #routeDevices(method: string, route: string[], res: ServerResponse): boolean {
    if (method === "GET" && route.length === 1 && route[0] === "devices") {
      sendJson(res, 200, { devices: this.#daemon.devices.list() });
      return true;
    }
    if (
      method === "POST" &&
      route.length === 3 &&
      route[0] === "devices" &&
      route[2] === "revoke" &&
      route[1].length > 0
    ) {
      sendJson(res, 200, {
        device: this.#daemon.devices.revoke(route[1]),
      });
      return true;
    }
    return false;
  }

  async #routeWorkspaces(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (method === "POST" && route.length === 1 && route[0] === "workspaces") {
      const body = checked<Static<typeof WorkspaceBodySchema>>(
        workspaceCheck,
        await readBody(req),
        "workspace"
      );
      const record = this.#daemon.workspaces.register(body);
      sendJson(res, 201, { workspace: record });
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "workspaces") {
      sendJson(res, 200, { workspaces: this.#daemon.workspaces.list() });
      return true;
    }
    if (
      method === "GET" &&
      route.length === 3 &&
      route[0] === "workspaces" &&
      route[2] === "file"
    ) {
      const path = url.searchParams.get("path");
      if (!path) {
        throw new OmoCommandError("unknown_schema", "file read requires path");
      }
      const file = readWorkspaceFile(
        this.#daemon.workspaces,
        decodeURIComponent(route[1]),
        path,
        MAX_FILE_READ_BYTES
      );
      sendJson(res, 200, { file });
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "sessions") {
      const workspaceId = url.searchParams.get("workspaceId");
      const sessions = workspaceId
        ? this.#daemon.catalog.listByWorkspace(workspaceId)
        : this.#daemon.catalog.listAll();
      sendJson(res, 200, { sessions });
      return true;
    }
    return this.#routeTerminals(method, route, url, res);
  }

  #routeTerminals(
    method: string,
    route: string[],
    url: URL,
    res: ServerResponse
  ): boolean {
    if (method === "GET" && route.length === 1 && route[0] === "terminals") {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) {
        throw new OmoCommandError(
          "unknown_schema",
          "GET /v1/terminals requires workspaceId"
        );
      }
      sendJson(res, 200, {
        terminals: this.#daemon.terminals.listByWorkspace(workspaceId),
      });
      return true;
    }
    if (method === "GET" && route.length === 2 && route[0] === "terminals") {
      const afterParam = url.searchParams.get("after");
      const snapshot = this.#daemon.terminals.snapshot(
        decodeURIComponent(route[1]),
        afterParam === null ? undefined : Number(afterParam)
      );
      if (!snapshot) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown terminal ${route[1]}`
        );
      }
      sendJson(res, 200, snapshot);
      return true;
    }
    return false;
  }

  async #routeArtifacts(
    method: string,
    route: string[],
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (method === "POST" && route.length === 1 && route[0] === "artifacts") {
      const bytes = await readRawBody(req, MAX_ARTIFACT_BYTES);
      if (bytes.length === 0) {
        throw new OmoCommandError("unknown_schema", "artifact body is empty");
      }
      const name = req.headers["x-omo-name"];
      const record = this.#daemon.artifacts.put(bytes, {
        mime:
          typeof req.headers["content-type"] === "string"
            ? req.headers["content-type"]
            : undefined,
        name: typeof name === "string" ? name : undefined,
      });
      sendJson(res, 201, { artifact: record });
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "artifacts") {
      sendJson(res, 200, { artifacts: this.#daemon.artifacts.list() });
      return true;
    }
    if (method === "GET" && route.length === 2 && route[0] === "artifacts") {
      const record = this.#daemon.artifacts.get(decodeURIComponent(route[1]));
      if (!record) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown artifact ${route[1]}`
        );
      }
      // Integrity is verified on every read (§5.8.3).
      const bytes = this.#daemon.artifacts.readBytes(record);
      res.writeHead(200, {
        "content-length": bytes.length,
        "content-type": record.mime ?? "application/octet-stream",
        "x-omo-sha256": record.sha256,
      });
      res.end(bytes);
      return true;
    }
    return false;
  }

  async #routeCommands(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    const { service } = this.#daemon;
    if (method === "POST" && route.length === 1 && route[0] === "commands") {
      const body = checked<Static<typeof SubmitCommandBodySchema>>(
        submitCheck,
        await readBody(req),
        "command"
      );
      const receipt = service.submit(body, principal);
      // 202: durably queued — never "work completed" (§5.4 step 5).
      sendJson(res, 202, { receipt });
      return true;
    }
    if (method === "GET" && route.length === 2 && route[0] === "commands") {
      const record = service.getCommand(decodeURIComponent(route[1]));
      if (!record) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown command ${route[1]}`
        );
      }
      sendJson(res, 200, { command: record });
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "commands") {
      const scope = scopeFromQuery(url.searchParams);
      if (!scope) {
        throw new OmoCommandError(
          "unknown_schema",
          "GET /v1/commands requires workspaceId"
        );
      }
      sendJson(res, 200, { commands: service.listCommands(scope) });
      return true;
    }
    return false;
  }

  async #routeSessionData(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    if (
      method === "POST" &&
      route.length === 2 &&
      route[0] === "sync" &&
      route[1] === "tickets"
    ) {
      sendJson(res, 201, this.#tickets.issue(principal, "sync"));
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "models") {
      sendJson(res, 200, { models: this.#daemon.runtime.listModels() });
      return true;
    }
    if (
      method === "GET" &&
      route.length === 3 &&
      route[0] === "sessions" &&
      route[2] === "history"
    ) {
      const sessionId = decodeURIComponent(route[1]);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === null ? undefined : Number(limitParam);
      const page = await this.#daemon.service.readHistory(sessionId, {
        cursor,
        limit,
      });
      sendJson(res, 200, page);
      return true;
    }
    return this.#routeDraft(method, route, req, res, principal);
  }

  async #routeDraft(
    method: string,
    route: string[],
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    const { service } = this.#daemon;
    if (
      !(route.length === 3 && route[0] === "sessions" && route[2] === "draft")
    ) {
      return false;
    }
    const sessionId = decodeURIComponent(route[1]);
    if (method === "GET") {
      const draft = service.getDraft(principal, sessionId);
      sendJson(res, 200, { draft: draft ?? null });
      return true;
    }
    if (method === "PUT") {
      const body = checked<Static<typeof DraftBodySchema>>(
        draftCheck,
        await readBody(req),
        "draft"
      );
      const result = service.putDraft(
        principal,
        sessionId,
        body.body,
        body.expectedRevision
      );
      if (!result.ok) {
        sendJson(res, 409, {
          draft: result.record ?? null,
          error: {
            code: "revision_mismatch",
            message: "draft revision mismatch",
            retryable: false,
          },
        });
        return true;
      }
      sendJson(res, 200, { draft: result.record });
      return true;
    }
    return false;
  }

  async #routeInteractions(
    method: string,
    route: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal
  ): Promise<boolean> {
    const { service } = this.#daemon;
    if (
      method === "POST" &&
      route.length === 1 &&
      route[0] === "interactions"
    ) {
      const body = checked<Static<typeof InteractionBodySchema>>(
        interactionCheck,
        await readBody(req),
        "interaction"
      );
      const record = service.createInteraction(body);
      sendJson(res, 201, { interaction: record });
      return true;
    }
    if (method === "GET" && route.length === 1 && route[0] === "interactions") {
      sendJson(res, 200, {
        interactions: service.listPendingInteractions(
          scopeFromQuery(url.searchParams)
        ),
      });
      return true;
    }
    if (method === "GET" && route.length === 2 && route[0] === "interactions") {
      const record = service.getInteraction(decodeURIComponent(route[1]));
      if (!record) {
        throw new OmoCommandError(
          "unknown_interaction",
          `unknown interaction ${route[1]}`
        );
      }
      sendJson(res, 200, { interaction: record });
      return true;
    }
    if (
      method === "POST" &&
      route.length === 3 &&
      route[0] === "interactions" &&
      route[2] === "answer"
    ) {
      const body = checked<Static<typeof AnswerBodySchema>>(
        answerCheck,
        await readBody(req),
        "interaction answer"
      );
      const result = service.answerInteraction(
        decodeURIComponent(route[1]),
        principal,
        body.answer,
        body.expectedRevision
      );
      if (!result.ok) {
        const code = ANSWER_ERROR_CODES[result.code] ?? "operation_mismatch";
        sendJson(res, STATUS_BY_CODE[code], {
          error: { code, message: result.code, retryable: false },
          interaction: result.record,
        });
        return true;
      }
      sendJson(res, 200, { interaction: result.record });
      return true;
    }
    return false;
  }

  /**
   * Serve the built SPA bundle from `webRoot` (non-/v1 GET/HEAD only).
   * Traversal-guarded via realpath; unknown paths fall back to index.html
   * (client-side routing). Content types by extension.
   */
  #serveWeb(pathname: string, res: ServerResponse, headOnly: boolean): void {
    const webRoot = this.#webRoot;
    if (!webRoot) {
      throw new OmoCommandError("unknown_command", "no web root configured");
    }
    let target = resolve(webRoot, `.${pathname}`);
    if (!isInside(webRoot, target)) {
      throw new OmoCommandError("permission_denied", "path escapes web root");
    }
    if (!(existsSync(target) && statSync(target).isFile())) {
      // SPA fallback: client-side routes render index.html.
      target = join(webRoot, "index.html");
    }
    if (!existsSync(target)) {
      throw new OmoCommandError(
        "unknown_command",
        "web bundle not found (run npm run build)"
      );
    }
    let bytes = readFileSync(target);
    // Serving the app from the daemon must boot the app in v2 mode: mark the
    // origin as the daemon so the web client never mistakes this process for
    // a v1 server (which would crash on shape mismatches).
    if (target.endsWith("index.html")) {
      const modeMarker =
        this.#webMode === "v1"
          ? "window.__OMO_SERVER_URL__=location.origin;window.__OMO_DAEMON_URL__=location.origin;window.__OMO_DAEMON_WEB_MODE__='v1'"
          : "window.__OMO_DAEMON_URL__=location.origin;window.__OMO_DAEMON_WEB_MODE__='v2'";
      const html = bytes
        .toString("utf8")
        .replace("</head>", `<script>${modeMarker}</script></head>`);
      bytes = Buffer.from(html, "utf8");
    }
    res.writeHead(200, {
      "cache-control": target.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "content-length": bytes.length,
      "content-type":
        MIME_BY_EXT[extname(target)] ?? "application/octet-stream",
    });
    if (headOnly) {
      res.end();
      return;
    }
    res.end(bytes);
  }

  listen(
    port: number,
    host = "127.0.0.1"
  ): Promise<{ host: string; port: number }> {
    return new Promise((resolvePromise, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        const address = this.#server.address();
        if (address && typeof address === "object") {
          resolvePromise({ host: address.address, port: address.port });
        } else {
          reject(new Error("server has no address"));
        }
      });
    });
  }

  close(): Promise<void> {
    this.#legacy.close();
    return new Promise((resolvePromise, reject) => {
      // Drop WS subscriptions first so no frame races the closing socket.
      this.#sync
        .close()
        .catch(() => undefined)
        .finally(() => {
          this.#server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolvePromise();
            }
          });
        });
    });
  }
}
