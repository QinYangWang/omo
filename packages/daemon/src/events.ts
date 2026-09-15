import type {
  RuntimeLaneEvent,
  RuntimeLaneSnapshot,
} from "@omo/agent-runtime/runtime";
import type { CommandRecord } from "@omo/control-plane/inbox";
import type { InteractionRecord } from "@omo/control-plane/interactions";
import type { DraftRecord } from "./drafts.ts";
import type { TerminalEvent } from "./terminal.ts";
import type { SessionCatalogEntry, WorkspaceRecord } from "./workspaces.ts";

/**
 * Daemon domain event bus (plan §6.5): the single fan-out point between the
 * durable stores / runtime watchers and the sync layer. Every event is a
 * COMMITTED fact (the stores only emit after their FULL-synchronous commit;
 * lane snapshots ride the runtime's own commit events) — never an in-memory
 * preview that a crash could contradict.
 */

export type DaemonEvent =
  | { readonly command: CommandRecord; readonly type: "command" }
  | { readonly draft: DraftRecord; readonly type: "draft" }
  | {
      readonly interaction: InteractionRecord;
      readonly type: "interaction";
    }
  | {
      readonly event: RuntimeLaneEvent;
      readonly sessionId: string;
      readonly snapshot: RuntimeLaneSnapshot;
      readonly type: "lane";
    }
  | { readonly session: SessionCatalogEntry; readonly type: "session" }
  | TerminalEvent
  | { readonly type: "workspace"; readonly workspace: WorkspaceRecord };

export type DaemonEventListener = (event: DaemonEvent) => void;

export class DaemonEventBus {
  readonly #listeners = new Set<DaemonEventListener>();

  emit(event: DaemonEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken sync listener must never disturb the control plane.
      }
    }
  }

  subscribe(listener: DaemonEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#listeners.size;
  }
}
