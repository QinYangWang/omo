import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Principal } from "@omo/control-plane/inbox";
import type { CommandScope } from "@omo/protocol/command";
import { OmoCommandError } from "@omo/protocol/errors";
import type { Frame } from "@omo/protocol/frame";
import {
  FRAME_SCHEMA_VERSION,
  OMO_PROTOCOL_VERSION,
} from "@omo/protocol/version";
import { WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./daemon.ts";
import type { DaemonEvent } from "./events.ts";
import type { TicketStore } from "./tickets.ts";

/**
 * Sync hub: the daemon's WSS control/subscription multiplex (plan §6.2, §6.3,
 * §6.4). One WebSocket connection carries many channel subscriptions; every
 * subscription starts with a snapshot at cursor "0" followed by live frames
 * with a strictly increasing per-subscription publicationSequence. Reconnect
 * = fresh snapshot (§6.4 首版允许重连直接 fresh snapshot；重放是优化，不在此版).
 *
 * Channels:
 *   daemon                  workspaces + session catalog facts
 *   workspace:<id>          workspace-scoped commands / interactions / sessions
 *   session:<id>            lane events + session-scoped commands /
 *                           interactions / the caller's own draft
 *
 * Backpressure (§8.5.10): a client whose socket buffer exceeds the cap is
 * sent `reset_required` per subscription and its subscriptions are dropped —
 * it must resubscribe and take a fresh snapshot rather than receive a stream
 * with silent gaps. Persistent control events are never dropped anywhere
 * else in the system; the WS tail is a projection, rebuildable by design.
 */

export type SyncChannel =
  | { readonly kind: "daemon" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "terminal"; readonly terminalId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string };

const WORKSPACE_CHANNEL = /^workspace:(\S+)$/;
const SESSION_CHANNEL = /^session:(\S+)$/;
const TERMINAL_CHANNEL = /^terminal:(\S+)$/;

export const parseChannel = (raw: string): SyncChannel => {
  if (raw === "daemon") {
    return { kind: "daemon" };
  }
  const workspaceMatch = WORKSPACE_CHANNEL.exec(raw);
  if (workspaceMatch) {
    return { kind: "workspace", workspaceId: workspaceMatch[1] };
  }
  const sessionMatch = SESSION_CHANNEL.exec(raw);
  if (sessionMatch) {
    return { kind: "session", sessionId: sessionMatch[1] };
  }
  const terminalMatch = TERMINAL_CHANNEL.exec(raw);
  if (terminalMatch) {
    return { kind: "terminal", terminalId: terminalMatch[1] };
  }
  throw new OmoCommandError("unknown_schema", `unknown channel "${raw}"`);
};

/** Max buffered bytes per connection before the tail is reset (§8.5.10). */
const MAX_BUFFERED_BYTES = 4_194_304;
const MAX_WS_MESSAGE_BYTES = 1_048_576;

interface SubscriptionState {
  readonly channel: SyncChannel;
  nextSeq: number;
}

interface ClientHello {
  readonly channel?: string;
  readonly cols?: number;
  readonly dataB64?: string;
  readonly rows?: number;
  readonly subscriptionId?: string;
  /** terminal.* frames (§6.6): real-time input/resize, never persisted. */
  readonly terminalId?: string;
  readonly type: string;
}

const EVENT_KINDS: Record<DaemonEvent["type"], string> = {
  command: "command.updated",
  draft: "draft.updated",
  interaction: "interaction.updated",
  lane: "lane.event",
  session: "session.created",
  terminal: "terminal",
  workspace: "workspace.registered",
};

const frameEventKind = (event: DaemonEvent): string =>
  event.type === "terminal"
    ? `terminal.${event.kind}`
    : EVENT_KINDS[event.type];

const eventScope = (
  event: DaemonEvent
): { sessionId?: string; workspaceId?: string } => {
  if (event.type === "command") {
    return {
      sessionId: event.command.scope.sessionId,
      workspaceId: event.command.scope.workspaceId,
    };
  }
  if (event.type === "interaction") {
    return {
      sessionId: event.interaction.scope.sessionId,
      workspaceId: event.interaction.scope.workspaceId,
    };
  }
  if (event.type === "lane") {
    return { sessionId: event.sessionId };
  }
  if (event.type === "session") {
    return {
      sessionId: event.session.sessionId,
      workspaceId: event.session.workspaceId,
    };
  }
  if (event.type === "workspace") {
    return { workspaceId: event.workspace.workspaceId };
  }
  if (event.type === "terminal") {
    return { workspaceId: event.terminal.workspaceId };
  }
  return { sessionId: event.draft.sessionId };
};

const eventPayload = (event: DaemonEvent): unknown => {
  if (event.type === "command") {
    return { command: event.command };
  }
  if (event.type === "draft") {
    return { draft: event.draft };
  }
  if (event.type === "interaction") {
    return { interaction: event.interaction };
  }
  if (event.type === "lane") {
    return { event: event.event, snapshot: event.snapshot };
  }
  if (event.type === "session") {
    return { session: event.session };
  }
  if (event.type === "terminal") {
    return { chunk: event.chunk, terminal: event.terminal };
  }
  return { workspace: event.workspace };
};

class SyncConnection {
  readonly #daemon: Daemon;
  readonly #principal: Principal;
  readonly #socket: WebSocket;
  readonly #subscriptions = new Map<string, SubscriptionState>();
  #overflowed = false;
  #unsubscribeBus: (() => void) | undefined;

  constructor(daemon: Daemon, principal: Principal, socket: WebSocket) {
    this.#daemon = daemon;
    this.#principal = principal;
    this.#socket = socket;
    // Device liveness drives terminal control handover (§6.6).
    daemon.connectedDevices.add(principal.deviceId);
    this.#unsubscribeBus = daemon.events.subscribe((event) => {
      this.#onEvent(event);
    });
    socket.on("message", (data) => {
      this.#onMessage(data);
    });
    socket.on("close", () => {
      this.dispose();
    });
    socket.on("error", () => {
      this.dispose();
    });
  }

  dispose(): void {
    this.#daemon.connectedDevices.delete(this.#principal.deviceId);
    this.#unsubscribeBus?.();
    this.#unsubscribeBus = undefined;
    this.#subscriptions.clear();
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
  }

  #send(frame: Frame): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: flipped by overflow policy
    if (this.#overflowed || this.#socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#overflowAll();
      return;
    }
    this.#socket.send(JSON.stringify(frame));
  }

  /** §8.5.10: drop the tail, tell the client to resnapshot every channel. */
  #overflowAll(): void {
    this.#overflowed = true;
    for (const [subscriptionId, state] of this.#subscriptions) {
      this.#sendRaw({
        kind: "reset_required",
        payload: {
          appliedCursor: String(state.nextSeq - 1),
          reason: "gap_detected",
        },
        payloadSchemaVersion: FRAME_SCHEMA_VERSION,
        protocolVersion: OMO_PROTOCOL_VERSION,
        publicationSequence: String(state.nextSeq),
        serverId: this.#daemon.identity.serverId,
        subscriptionId,
      });
    }
    this.#subscriptions.clear();
  }

  /** Bypass the overflow gate: used only for reset_required itself. */
  #sendRaw(frame: Frame): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      try {
        this.#socket.send(JSON.stringify(frame));
      } catch {
        this.dispose();
      }
    }
  }

  #sendError(code: string, message: string): void {
    this.#sendRaw({
      kind: "error",
      payload: { code, message },
      payloadSchemaVersion: FRAME_SCHEMA_VERSION,
      protocolVersion: OMO_PROTOCOL_VERSION,
      serverId: this.#daemon.identity.serverId,
    });
  }

  #onMessage(data: unknown): void {
    const bytes = data as Buffer;
    if (bytes.length > MAX_WS_MESSAGE_BYTES) {
      this.#sendError("quota_exceeded", "frame too large");
      return;
    }
    let message: ClientHello;
    try {
      message = JSON.parse(bytes.toString("utf8")) as ClientHello;
    } catch {
      this.#sendError("unknown_schema", "frames must be JSON");
      return;
    }
    if (message.type === "ping") {
      this.#sendRaw({
        kind: "pong",
        payload: {},
        payloadSchemaVersion: FRAME_SCHEMA_VERSION,
        protocolVersion: OMO_PROTOCOL_VERSION,
        serverId: this.#daemon.identity.serverId,
      });
      return;
    }
    if (message.type === "unsubscribe" && message.subscriptionId) {
      this.#subscriptions.delete(message.subscriptionId);
      return;
    }
    if (message.type === "terminal.input") {
      this.#onTerminalInput(message);
      return;
    }
    if (message.type === "terminal.resize") {
      this.#onTerminalResize(message);
      return;
    }
    if (message.type === "subscribe") {
      this.#onSubscribe(message);
      return;
    }
    this.#sendError(
      "unknown_schema",
      `unknown client frame type "${message.type}"`
    );
  }

  /**
   * Terminal input/resize are real-time control messages: checked against
   * the durable ownership record, never persisted (§5.8 terminal boundary).
   */
  #onTerminalInput(message: ClientHello): void {
    if (!(message.terminalId && message.dataB64)) {
      this.#sendError(
        "unknown_schema",
        "terminal.input requires terminalId and dataB64"
      );
      return;
    }
    try {
      this.#daemon.terminals.writeInput(
        message.terminalId,
        this.#principal,
        Buffer.from(message.dataB64, "base64").toString("utf8")
      );
    } catch (error) {
      if (error instanceof OmoCommandError) {
        this.#sendError(error.code, error.message);
        return;
      }
      throw error;
    }
  }

  #onTerminalResize(message: ClientHello): void {
    if (
      !(
        message.terminalId &&
        typeof message.cols === "number" &&
        typeof message.rows === "number" &&
        Number.isFinite(message.cols) &&
        Number.isFinite(message.rows)
      )
    ) {
      this.#sendError(
        "unknown_schema",
        "terminal.resize requires terminalId, cols and rows"
      );
      return;
    }
    try {
      this.#daemon.terminals.resize(
        message.terminalId,
        this.#principal,
        message.cols,
        message.rows
      );
    } catch (error) {
      if (error instanceof OmoCommandError) {
        this.#sendError(error.code, error.message);
        return;
      }
      throw error;
    }
  }

  #onSubscribe(message: ClientHello): void {
    const { subscriptionId } = message;
    if (!(subscriptionId && message.channel)) {
      this.#sendError(
        "unknown_schema",
        "subscribe requires subscriptionId and channel"
      );
      return;
    }
    if (this.#subscriptions.has(subscriptionId)) {
      this.#sendError(
        "operation_mismatch",
        `duplicate subscription ${subscriptionId}`
      );
      return;
    }
    let channel: SyncChannel;
    try {
      channel = parseChannel(message.channel);
    } catch (error) {
      this.#sendError("unknown_schema", (error as Error).message);
      return;
    }
    let snapshot: unknown;
    try {
      snapshot = this.#buildSnapshot(channel);
    } catch (error) {
      if (error instanceof OmoCommandError) {
        this.#sendError(error.code, error.message);
        return;
      }
      throw error;
    }
    // Fresh subscription: overflow state clears because the client is about
    // to receive a consistent snapshot boundary (§6.4).
    this.#overflowed = false;
    const state: SubscriptionState = { channel, nextSeq: 1 };
    this.#subscriptions.set(subscriptionId, state);
    this.#send({
      cursor: "0",
      kind: "snapshot",
      payload: snapshot,
      payloadSchemaVersion: FRAME_SCHEMA_VERSION,
      protocolVersion: OMO_PROTOCOL_VERSION,
      publicationSequence: "0",
      serverId: this.#daemon.identity.serverId,
      subscriptionId,
      workspaceId:
        channel.kind === "workspace" ? channel.workspaceId : undefined,
    });
  }

  #buildSnapshot(channel: SyncChannel): unknown {
    const daemon = this.#daemon;
    if (channel.kind === "daemon") {
      return {
        identity: daemon.identity,
        sessions: daemon.catalog.listAll(),
        workspaces: daemon.workspaces.list(),
      };
    }
    if (channel.kind === "workspace") {
      const workspace = daemon.workspaces.get(channel.workspaceId);
      if (!workspace) {
        throw new OmoCommandError(
          "unknown_workspace",
          `unknown workspace ${channel.workspaceId}`
        );
      }
      const scope: CommandScope = { workspaceId: channel.workspaceId };
      return {
        commands: daemon.service.listCommands(scope).slice(-500),
        pendingInteractions: daemon.service.listPendingInteractions(scope),
        sessions: daemon.catalog.listByWorkspace(channel.workspaceId),
        workspace,
      };
    }
    if (channel.kind === "terminal") {
      return this.#terminalSnapshot(channel.terminalId);
    }
    const entry = daemon.catalog.get(channel.sessionId);
    const workspaceId = entry?.workspaceId;
    const scope: CommandScope | undefined = workspaceId
      ? { sessionId: channel.sessionId, workspaceId }
      : undefined;
    return {
      commands: scope ? daemon.service.listCommands(scope).slice(-500) : [],
      draft: daemon.drafts.get(this.#principal.userId, channel.sessionId),
      lane: daemon.supervisor.laneSnapshot(channel.sessionId) ?? null,
      pendingInteractions: scope
        ? daemon.service.listPendingInteractions(scope)
        : [],
      session: entry ?? null,
    };
  }

  #terminalSnapshot(terminalId: string): unknown {
    const snapshot = this.#daemon.terminals.snapshot(terminalId);
    if (!snapshot) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown terminal ${terminalId}`
      );
    }
    return snapshot;
  }

  #onEvent(event: DaemonEvent): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: flipped by overflow policy
    if (this.#overflowed) {
      return;
    }
    const kind = frameEventKind(event);
    const scope = eventScope(event);
    for (const [subscriptionId, state] of this.#subscriptions) {
      if (!matchesChannel(state.channel, event, this.#principal)) {
        continue;
      }
      const sequence = String(state.nextSeq);
      state.nextSeq += 1;
      this.#send({
        cursor: sequence,
        kind,
        laneId: undefined,
        payload: eventPayload(event),
        payloadSchemaVersion: FRAME_SCHEMA_VERSION,
        protocolVersion: OMO_PROTOCOL_VERSION,
        publicationSequence: sequence,
        serverId: this.#daemon.identity.serverId,
        sessionId: scope.sessionId,
        subscriptionId,
        workspaceId: scope.workspaceId,
      });
    }
  }
}

const matchesChannel = (
  channel: SyncChannel,
  event: DaemonEvent,
  principal: Principal
): boolean => {
  if (channel.kind === "daemon") {
    return event.type === "workspace" || event.type === "session";
  }
  if (channel.kind === "workspace") {
    // Output stays on the terminal channel; lifecycle flows to the workspace.
    if (event.type === "terminal") {
      return (
        event.kind !== "output" &&
        event.terminal.workspaceId === channel.workspaceId
      );
    }
    return eventScope(event).workspaceId === channel.workspaceId;
  }
  if (channel.kind === "terminal") {
    return event.type === "terminal" && event.terminalId === channel.terminalId;
  }
  if (event.type === "lane") {
    return event.sessionId === channel.sessionId;
  }
  if (event.type === "draft") {
    return (
      event.draft.sessionId === channel.sessionId &&
      event.draft.userId === principal.userId
    );
  }
  return eventScope(event).sessionId === channel.sessionId;
};

export class SyncHub {
  readonly #daemon: Daemon;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<SyncConnection>();

  constructor(daemon: Daemon) {
    this.#daemon = daemon;
    this.#wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Attach to the daemon's HTTP server: GET /v1/sync upgrades with a
   * one-time `ticket` query parameter (§10.1 ticket binding).
   */
  attach(server: HttpServer, tickets: TicketStore): void {
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/v1/sync") {
          // The v1 compatibility terminal stream is attached by the HTTP
          // boundary; reject unrelated upgrade paths instead of leaving the
          // socket hanging.
          if (!url.pathname.startsWith("/api/v1/terminals/")) {
            socket.destroy();
          }
          return;
        }
        const principal = tickets.consume(
          url.searchParams.get("ticket") ?? "",
          "sync"
        );
        if (!principal) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n"
          );
          socket.destroy();
          return;
        }
        this.#wss.handleUpgrade(request, socket, head, (ws) => {
          const connection = new SyncConnection(this.#daemon, principal, ws);
          this.#connections.add(connection);
          ws.on("close", () => {
            this.#connections.delete(connection);
          });
        });
      }
    );
  }

  connectionCount(): number {
    return this.#connections.size;
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.dispose();
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => resolve());
    });
  }
}
