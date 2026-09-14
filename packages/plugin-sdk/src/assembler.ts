import type {
  NodeFact,
  NodeIdentity,
  NodeViewModel,
} from "@omo/plugin-ui-schema/nodes";

/**
 * Deterministic conversation node assembler (plan §7.0, §7.6).
 *
 * Folds durable start / update / terminal facts into view models by stable
 * entity identity. Guarantees:
 *  - live append, history prepend and full replay of the same fact set fold
 *    into the SAME final view models (compared as a sorted set);
 *  - updates arriving before their start stay pending and replay
 *    deterministically once the start lands;
 *  - a terminal fact settles the entity: the terminal payload REPLACES the
 *    streamed payload fields, never concatenates onto them;
 *  - duplicate facts (same entitySeq) are idempotent no-ops.
 */

const identityKey = (identity: NodeIdentity): string =>
  `${identity.pluginId}/${identity.kind}/${identity.entityId}`;

interface EntityState {
  /** Buffered facts that arrived before the start fact. */
  pending: NodeFact[];
  view: {
    appliedFacts: number;
    generation: string;
    identity: NodeIdentity;
    lastEntitySeq: number;
    payload: unknown;
    payloadVersion: number;
    state: "pending" | "open" | "settled";
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Field-wise merge: incoming fields replace streamed ones (never append). */
const mergePayload = (base: unknown, next: unknown): unknown => {
  if (isPlainObject(base) && isPlainObject(next)) {
    return { ...base, ...next };
  }
  return next;
};

export class NodeAssembler {
  readonly #entities = new Map<string, EntityState>();

  /** Fold one fact. Returns the updated view model for the entity. */
  apply(fact: NodeFact): NodeViewModel {
    const key = identityKey(fact.identity);
    let state = this.#entities.get(key);
    if (!state) {
      state = {
        pending: [],
        view: {
          appliedFacts: 0,
          generation: fact.generation,
          identity: fact.identity,
          lastEntitySeq: -1,
          payload: undefined,
          payloadVersion: fact.payloadVersion,
          state: "pending",
        },
      };
      this.#entities.set(key, state);
    }

    if (fact.entitySeq <= state.view.lastEntitySeq) {
      // Duplicate or stale fact: idempotent no-op.
      return this.toViewModel(state.view);
    }

    if (fact.factType === "start") {
      state.view = {
        appliedFacts: state.view.appliedFacts + 1,
        generation: fact.generation,
        identity: fact.identity,
        lastEntitySeq: fact.entitySeq,
        payload: fact.payload,
        payloadVersion: fact.payloadVersion,
        state: "open",
      };
      // Deterministically replay buffered tail facts in entitySeq order.
      const buffered = [...state.pending].sort(
        (a, b) => a.entitySeq - b.entitySeq
      );
      state.pending = [];
      for (const bufferedFact of buffered) {
        if (bufferedFact.entitySeq > state.view.lastEntitySeq) {
          this.foldNonStart(state.view, bufferedFact);
        }
      }
      return this.toViewModel(state.view);
    }

    if (state.view.state === "pending") {
      state.pending.push(fact);
      return this.toViewModel(state.view);
    }

    this.foldNonStart(state.view, fact);
    return this.toViewModel(state.view);
  }

  private foldNonStart(view: EntityState["view"], fact: NodeFact): void {
    view.payload = mergePayload(view.payload, fact.payload);
    view.payloadVersion = fact.payloadVersion;
    view.generation = fact.generation;
    view.lastEntitySeq = fact.entitySeq;
    view.appliedFacts += 1;
    if (fact.factType === "terminal") {
      view.state = "settled";
    }
  }

  private toViewModel(view: EntityState["view"]): NodeViewModel {
    return { ...view };
  }

  /**
   * All current view models in canonical order (identity-key sorted), so the
   * result is identical regardless of fact arrival order (live vs prepend).
   */
  snapshot(): readonly NodeViewModel[] {
    return [...this.#entities.keys()]
      .sort()
      .map((key) =>
        this.toViewModel(this.#entities.get(key)?.view as EntityState["view"])
      );
  }

  /** Drop one entity (e.g. after session deletion), running no side effects. */
  remove(identity: NodeIdentity): boolean {
    return this.#entities.delete(identityKey(identity));
  }

  get size(): number {
    return this.#entities.size;
  }
}
