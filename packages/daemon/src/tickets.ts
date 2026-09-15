import { randomBytes } from "node:crypto";
import type { Principal } from "@omo/control-plane/inbox";

/**
 * One-time sync tickets (plan §10.1): WSS upgrade never carries the long-lived
 * device credential; clients exchange it over HTTPS for a short-lived,
 * single-use, purpose-bound ticket. Tickets live in memory only — a daemon
 * restart simply requires a fresh ticket (the device token is untouched).
 */

interface TicketRecord {
  readonly expiresAt: number;
  readonly principal: Principal;
  readonly purpose: string;
}

const DEFAULT_TTL_MS = 30_000;

export class TicketStore {
  readonly #tickets = new Map<string, TicketRecord>();

  issue(
    principal: Principal,
    purpose: string,
    ttlMs = DEFAULT_TTL_MS
  ): { readonly expiresAt: string; readonly ticket: string } {
    const ticket = `otk_${randomBytes(24).toString("hex")}`;
    const expiresAt = Date.now() + ttlMs;
    this.#tickets.set(ticket, { expiresAt, principal, purpose });
    return { expiresAt: new Date(expiresAt).toISOString(), ticket };
  }

  /** One-time consumption: a spent or expired ticket never authenticates. */
  consume(ticket: string, purpose: string): Principal | undefined {
    const record = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (
      !record ||
      record.purpose !== purpose ||
      record.expiresAt < Date.now()
    ) {
      return undefined;
    }
    return record.principal;
  }

  /** Bound memory: expired tickets are swept lazily on issue. */
  sweep(): void {
    const now = Date.now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt < now) {
        this.#tickets.delete(ticket);
      }
    }
  }
}
