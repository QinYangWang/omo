import type { CommandReceipt, CommandScope } from "@omo/protocol/command";
import { OmoCommandError } from "@omo/protocol/errors";

/**
 * omo daemon TS client (plan §6.2, ADR-004): HTTPS command/query surface.
 * The WSS multiplex lives in sync-client.ts. Identity (device token) is
 * obtained once via pairing; sync connections never carry it — they use
 * one-time tickets (§10.1).
 *
 * This client is transport-only: it throws OmoCommandError for daemon error
 * bodies and otherwise returns parsed payloads. View models and reducers
 * belong to the app layer.
 */

export interface OmoClientOptions {
  readonly baseUrl: string;
  readonly token: string;
}

const parseError = async (response: Response): Promise<OmoCommandError> => {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; retryable?: boolean };
    };
    if (body.error?.code) {
      return new OmoCommandError(
        body.error.code as never,
        body.error.message ?? response.statusText,
        body.error.retryable === true
      );
    }
  } catch {
    // fall through to a generic error
  }
  return new OmoCommandError("internal", `HTTP ${response.status}`);
};

const TRAILING_SLASHES = /\/+$/;
const HTTP_SCHEME = /^http/;

/** DOM/Node-safe binary body: ArrayBuffer is valid for both fetch flavors. */
const toArrayBuffer = (bytes: Buffer | Uint8Array): ArrayBuffer => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
};

export class OmoClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #deviceId?: string;

  constructor(options: OmoClientOptions & { readonly deviceId?: string }) {
    this.#baseUrl = options.baseUrl.replace(TRAILING_SLASHES, "");
    this.#token = options.token;
    this.#deviceId = options.deviceId;
  }

  /** This device's id, when the client was created by pairing. */
  get deviceId(): string | undefined {
    return this.#deviceId;
  }

  /** Base URL (used to derive the sync WebSocket URL). */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * The device credential. Deliberately exposed for the client-owning app
   * layer (connection config handoff); never send it off the daemon's own
   * origin (§10.1).
   */
  get token(): string {
    return this.#token;
  }

  static async pair(
    baseUrl: string,
    code: string,
    name?: string
  ): Promise<OmoClient> {
    const response = await fetch(
      `${baseUrl.replace(TRAILING_SLASHES, "")}/v1/pairing`,
      {
        body: JSON.stringify({ code, name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    if (!response.ok) {
      throw await parseError(response);
    }
    const body = (await response.json()) as { deviceId: string; token: string };
    return new OmoClient({
      baseUrl,
      deviceId: body.deviceId,
      token: body.token,
    });
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: { body: Buffer | Uint8Array; contentType: string; name?: string }
  ): Promise<T> {
    let requestBody: ArrayBuffer | string | undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
    };
    if (raw) {
      requestBody = toArrayBuffer(raw.body);
      headers["content-type"] = raw.contentType;
      if (raw.name) {
        headers["x-omo-name"] = raw.name;
      }
    } else if (body !== undefined) {
      requestBody = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${this.#baseUrl}${path}`, {
      body: requestBody,
      headers,
      method,
    });
    if (!response.ok) {
      throw await parseError(response);
    }
    return (await response.json()) as T;
  }

  // ----------------------------------------------------------------- status

  /** Public handshake: daemon identity + durability report (§5.8.6). */
  hello(): Promise<unknown> {
    return this.#request("GET", "/v1/hello");
  }

  // ---------------------------------------------------------------- commands

  submitCommand(input: {
    readonly clientMutationId: string;
    readonly commandId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly scope: CommandScope;
    readonly expectedOperationId?: string;
    readonly expectedRevision?: string;
  }): Promise<{ receipt: CommandReceipt }> {
    return this.#request("POST", "/v1/commands", input);
  }

  getCommand(commandId: string): Promise<unknown> {
    return this.#request(
      "GET",
      `/v1/commands/${encodeURIComponent(commandId)}`
    );
  }

  listCommands(scope: CommandScope): Promise<unknown> {
    const params = new URLSearchParams({ workspaceId: scope.workspaceId });
    if (scope.sessionId) {
      params.set("sessionId", scope.sessionId);
    }
    if (scope.laneId) {
      params.set("laneId", scope.laneId);
    }
    return this.#request("GET", `/v1/commands?${params}`);
  }

  // -------------------------------------------------------------- workspaces

  registerWorkspace(path: string, name?: string): Promise<unknown> {
    return this.#request("POST", "/v1/workspaces", { name, path });
  }

  listWorkspaces(): Promise<unknown> {
    return this.#request("GET", "/v1/workspaces");
  }

  listSessions(workspaceId?: string): Promise<unknown> {
    const params = workspaceId
      ? new URLSearchParams({ workspaceId })
      : new URLSearchParams();
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.#request("GET", `/v1/sessions${suffix}`);
  }

  /** Provider catalog available to the daemon (§6.6 改模型 choices). */
  listModels(): Promise<unknown> {
    return this.#request("GET", "/v1/models");
  }

  // --------------------------------------------------------------- terminals

  /**
   * Create a PTY in a workspace. The receipt's operationId IS the terminal
   * id (§5.4); the terminal record completes asynchronously.
   */
  createTerminal(input: {
    readonly clientMutationId: string;
    readonly commandId: string;
    readonly workspaceId: string;
    readonly cols?: number;
    readonly cwd?: string;
    readonly name?: string;
    readonly rows?: number;
    readonly shell?: string;
  }): Promise<{ receipt: CommandReceipt }> {
    const { clientMutationId, commandId, workspaceId, ...payload } = input;
    return this.#request("POST", "/v1/commands", {
      clientMutationId,
      commandId,
      kind: "terminal.create",
      payload,
      scope: { workspaceId },
    });
  }

  killTerminal(
    terminalId: string,
    workspaceId: string,
    mutation: string
  ): Promise<{ receipt: CommandReceipt }> {
    return this.#request("POST", "/v1/commands", {
      clientMutationId: mutation,
      commandId: `cmd_kill_${mutation}`,
      kind: "terminal.kill",
      payload: { terminalId },
      scope: { workspaceId },
    });
  }

  controlTerminal(
    terminalId: string,
    workspaceId: string,
    action: "acquire" | "force" | "release",
    mutation: string
  ): Promise<{ receipt: CommandReceipt }> {
    return this.#request("POST", "/v1/commands", {
      clientMutationId: mutation,
      commandId: `cmd_control_${mutation}`,
      kind: "terminal.control",
      payload: { action, terminalId },
      scope: { workspaceId },
    });
  }

  listTerminals(workspaceId: string): Promise<unknown> {
    return this.#request(
      "GET",
      `/v1/terminals?workspaceId=${encodeURIComponent(workspaceId)}`
    );
  }

  getTerminal(terminalId: string, after?: number): Promise<unknown> {
    const suffix =
      after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
    return this.#request(
      "GET",
      `/v1/terminals/${encodeURIComponent(terminalId)}${suffix}`
    );
  }

  // ---------------------------------------------------------------- history

  readHistory(
    sessionId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (options?.cursor) {
      params.set("cursor", options.cursor);
    }
    if (options?.limit) {
      params.set("limit", String(options.limit));
    }
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.#request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/history${suffix}`
    );
  }

  // ----------------------------------------------------------------- drafts

  getDraft(sessionId: string): Promise<unknown> {
    return this.#request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/draft`
    );
  }

  putDraft(
    sessionId: string,
    body: string,
    expectedRevision?: number
  ): Promise<unknown> {
    return this.#request(
      "PUT",
      `/v1/sessions/${encodeURIComponent(sessionId)}/draft`,
      { body, expectedRevision }
    );
  }

  // ------------------------------------------------------------ interactions

  createInteraction(input: unknown): Promise<unknown> {
    return this.#request("POST", "/v1/interactions", input);
  }

  answerInteraction(
    interactionId: string,
    answer: unknown,
    expectedRevision?: number
  ): Promise<unknown> {
    return this.#request(
      "POST",
      `/v1/interactions/${encodeURIComponent(interactionId)}/answer`,
      { answer, expectedRevision }
    );
  }

  listInteractions(): Promise<unknown> {
    return this.#request("GET", "/v1/interactions");
  }

  // --------------------------------------------------------------- artifacts

  uploadArtifact(
    bytes: Buffer | Uint8Array,
    meta?: { mime?: string; name?: string }
  ): Promise<unknown> {
    return this.#request("POST", "/v1/artifacts", undefined, {
      body: bytes,
      contentType: meta?.mime ?? "application/octet-stream",
      name: meta?.name,
    });
  }

  async downloadArtifact(artifactId: string): Promise<Uint8Array> {
    const response = await fetch(
      `${this.#baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { authorization: `Bearer ${this.#token}` } }
    );
    if (!response.ok) {
      throw await parseError(response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  listArtifacts(): Promise<unknown> {
    return this.#request("GET", "/v1/artifacts");
  }

  // ------------------------------------------------------------------- sync

  /** Exchange the device credential for a one-time sync ticket (§10.1). */
  issueSyncTicket(): Promise<{ expiresAt: string; ticket: string }> {
    return this.#request("POST", "/v1/sync/tickets");
  }

  /**
   * Build a sync client bound to this device: tickets are re-issued per
   * connect (they are one-time), the WS URL derives from the base URL.
   */
  async createSyncClient(options?: {
    readonly onError?: (error: { code: string; message: string }) => void;
    readonly reconnectDelayMs?: number;
    readonly url?: string;
  }): Promise<import("./sync-client.ts").OmoSyncClient> {
    const { OmoSyncClient } = await import("./sync-client.ts");
    const wsUrl =
      options?.url ?? `${this.#baseUrl.replace(HTTP_SCHEME, "ws")}/v1/sync`;
    return new OmoSyncClient({
      onError: options?.onError,
      reconnectDelayMs: options?.reconnectDelayMs,
      ticketProvider: async () => (await this.issueSyncTicket()).ticket,
      url: wsUrl,
    });
  }
}
