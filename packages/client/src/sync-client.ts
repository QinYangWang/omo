import type { Frame } from "@omo/protocol/frame";
import { FrameSchema } from "@omo/protocol/frame";
import { Compile } from "typebox/compile";

/**
 * Sync client for the daemon's WSS multiplex (plan §6.2–§6.4, ADR-004).
 *
 * Semantics:
 *  - one connection carries many channel subscriptions;
 *  - every (re)subscribe yields a fresh snapshot at cursor "0", then live
 *    frames with a strictly increasing publicationSequence — a gap on a live
 *    connection triggers onReset and an automatic resubscribe (§6.4 step 5);
 *  - reconnects re-fetch a one-time ticket via `ticketProvider` (the device
 *    token never touches the WebSocket path, §10.1) and resubscribe all
 *    channels;
 *  - unknown frame kinds are surfaced to handlers, never silently dropped
 *    (§6.3).
 */

const frameCheck = Compile(FrameSchema);

const newSubscriptionId = (): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

/** Cross-platform UTF-8 → base64 (Node Buffer or browser btoa). */
const utf8ToBase64 = (text: string): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  return btoa(unescape(encodeURIComponent(text)));
};

export interface SyncHandlers {
  readonly onError?: (error: { code: string; message: string }) => void;
  readonly onFrame?: (frame: Frame) => void;
  readonly onReset?: (subscriptionId: string, reason: string) => void;
  readonly onSnapshot?: (subscriptionId: string, payload: unknown) => void;
}

interface Subscription {
  readonly channel: string;
  readonly handlers: SyncHandlers;
  /** Next expected publicationSequence on the live tail. */
  nextSeq: bigint;
  readonly subscriptionId: string;
}

export interface OmoSyncClientOptions {
  /** Connection-level frames (e.g. terminal permission errors). */
  readonly onError?: (error: { code: string; message: string }) => void;
  /** Test hook for reconnect delay. */
  readonly reconnectDelayMs?: number;
  /** Re-issued per connect: tickets are one-time (§10.1). */
  readonly ticketProvider: () => Promise<string>;
  /** e.g. ws://127.0.0.1:5190/v1/sync */
  readonly url: string;
}

export class OmoSyncClient {
  readonly #options: OmoSyncClientOptions;
  readonly #subscriptions = new Map<string, Subscription>();
  #closed = false;
  #socket: WebSocket | undefined;
  #connecting: Promise<void> | undefined;

  constructor(options: OmoSyncClientOptions) {
    this.#options = options;
  }

  connect(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed) {
      return Promise.reject(new Error("sync client is closed"));
    }
    this.#connecting ??= this.#open().catch((error: unknown) => {
      this.#connecting = undefined;
      throw error;
    });
    return this.#connecting;
  }

  async #open(): Promise<void> {
    const ticket = await this.#options.ticketProvider();
    const socket = new WebSocket(
      `${this.#options.url}?ticket=${encodeURIComponent(ticket)}`
    );
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("sync socket failed"));
    });
    socket.onmessage = (event) => {
      this.#onMessage(event.data);
    };
    socket.onclose = () => {
      this.#onClose();
    };
    // (Re)subscribe every channel: each gets a fresh snapshot (§6.4).
    for (const subscription of this.#subscriptions.values()) {
      subscription.nextSeq = 1n;
      this.#sendSubscribe(subscription);
    }
  }

  subscribe(channel: string, handlers: SyncHandlers): string {
    const subscriptionId = `sub_${newSubscriptionId()}`;
    const subscription: Subscription = {
      channel,
      handlers,
      nextSeq: 1n,
      subscriptionId,
    };
    this.#subscriptions.set(subscriptionId, subscription);
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#sendSubscribe(subscription);
    }
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    if (this.#subscriptions.delete(subscriptionId)) {
      this.#send({ subscriptionId, type: "unsubscribe" });
    }
  }

  /**
   * Terminal input: real-time control message — requires this device to
   * hold terminal input control (§6.6), never persisted (§5.8).
   */
  sendTerminalInput(terminalId: string, data: string): void {
    this.#send({
      dataB64: utf8ToBase64(data),
      terminalId,
      type: "terminal.input",
    });
  }

  sendTerminalResize(terminalId: string, cols: number, rows: number): void {
    this.#send({
      cols,
      rows,
      terminalId,
      type: "terminal.resize",
    });
  }

  #sendSubscribe(subscription: Subscription): void {
    this.#send({
      channel: subscription.channel,
      subscriptionId: subscription.subscriptionId,
      type: "subscribe",
    });
  }

  #send(message: Record<string, number | string>): void {
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  #onMessage(data: unknown): void {
    let frame: Frame;
    try {
      const parsed = JSON.parse(String(data));
      if (!frameCheck.Check(parsed)) {
        return; // unknown control data: rejected by silence + never applied
      }
      frame = parsed as Frame;
    } catch {
      return;
    }
    const { subscriptionId } = frame;
    if (!subscriptionId) {
      if (frame.kind === "error") {
        const payload = frame.payload as { code?: string; message?: string };
        this.#options.onError?.({
          code: payload.code ?? "internal",
          message: payload.message ?? "unknown sync error",
        });
      }
      return; // pong frames carry no subscriptionId either
    }
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription) {
      return; // frame for an already-unsubscribed channel
    }
    if (frame.kind === "snapshot") {
      subscription.nextSeq = 1n;
      subscription.handlers.onSnapshot?.(subscriptionId, frame.payload);
      return;
    }
    if (frame.kind === "reset_required") {
      const payload = frame.payload as { reason?: string };
      subscription.handlers.onReset?.(
        subscriptionId,
        payload.reason ?? "gap_detected"
      );
      // Resubscribe for a fresh snapshot boundary (§6.4 step 5).
      subscription.nextSeq = 1n;
      this.#sendSubscribe(subscription);
      return;
    }
    // Live tail: enforce the per-subscription sequence (§6.4 step 4).
    const sequence = BigInt(frame.publicationSequence ?? "0");
    if (sequence !== subscription.nextSeq) {
      subscription.handlers.onReset?.(subscriptionId, "gap_detected");
      subscription.nextSeq = 1n;
      this.#sendSubscribe(subscription);
      return;
    }
    subscription.nextSeq = sequence + 1n;
    subscription.handlers.onFrame?.(frame);
  }

  #onClose(): void {
    this.#socket = undefined;
    this.#connecting = undefined;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed || this.#subscriptions.size === 0) {
      return;
    }
    this.#attemptReconnect(1);
  }

  /**
   * Reconnect with a FRESH one-time ticket and resnapshot every channel
   * (§6.4). Retries with bounded backoff while subscriptions remain; the
   * daemon being offline surfaces via onError on each failed attempt.
   */
  #attemptReconnect(attempt: number): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed || this.#subscriptions.size === 0) {
      return;
    }
    const base = this.#options.reconnectDelayMs ?? 200;
    const delay = Math.min(base * attempt, 5000);
    setTimeout(() => {
      this.connect().catch(() => {
        for (const subscription of this.#subscriptions.values()) {
          subscription.handlers.onError?.({
            code: "daemon_offline",
            message: `sync reconnect attempt ${attempt} failed`,
          });
        }
        this.#attemptReconnect(attempt + 1);
      });
    }, delay);
  }

  close(): void {
    this.#closed = true;
    this.#subscriptions.clear();
    this.#socket?.close();
    this.#socket = undefined;
  }
}
