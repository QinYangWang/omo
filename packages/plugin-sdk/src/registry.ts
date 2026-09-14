import { getSlot } from "./slots.ts";

/**
 * Host-side contribution registry (plan §7.4 B, §7.10).
 *
 * Plugin tool / UI contributions are DATA owned by the host — not service
 * members that mutate the Chord graph. The registry is keyed by
 * (pluginId, generationId), rebuilt deterministically on every generation
 * swap, and activating a new generation disposes the old one's cleanups.
 * Recovery never relies on "undoing old code's side effects".
 */

export type ContributionErrorCode =
  | "unknown_slot"
  | "duplicate_contribution"
  | "cardinality_violation";

export class ContributionError extends Error {
  readonly code: ContributionErrorCode;
  constructor(code: ContributionErrorCode, message: string) {
    super(message);
    this.name = "ContributionError";
    this.code = code;
  }
}

export interface Contribution {
  /** Runs when the owning generation retires. */
  readonly cleanup?: () => void;
  readonly contributionId: string;
  /** Slot-specific payload (renderer, action descriptor, panel DTO...). */
  readonly payload: unknown;
  readonly slot: string;
}

interface ActiveGeneration {
  readonly contributions: readonly (Contribution & { readonly slot: string })[];
  readonly generationId: string;
}

export interface RegistryView {
  /** Keyed slots: contributionId → payload (e.g. node kind → renderer). */
  readonly keyed: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
  /** List slots: deterministic (contributionId-sorted) payload list. */
  readonly lists: ReadonlyMap<string, readonly unknown[]>;
}

const applyContribution = (
  keyed: Map<string, Map<string, unknown>>,
  lists: Map<string, unknown[]>,
  contribution: Contribution
): void => {
  const slot = getSlot(contribution.slot);
  if (!slot) {
    return;
  }
  if (slot.cardinality === "keyed") {
    let byKey = keyed.get(contribution.slot);
    if (!byKey) {
      byKey = new Map();
      keyed.set(contribution.slot, byKey);
    }
    // First plugin (sorted) wins a key collision across plugins; the
    // host must surface this as an activation-time conflict in P3.
    if (!byKey.has(contribution.contributionId)) {
      byKey.set(contribution.contributionId, contribution.payload);
    }
    return;
  }
  let list = lists.get(contribution.slot);
  if (!list) {
    list = [];
    lists.set(contribution.slot, list);
  }
  list.push(contribution.payload);
};

export class ContributionRegistry {
  /** pluginId → active generation. */
  readonly #active = new Map<string, ActiveGeneration>();

  /**
   * Activate a generation's contributions, replacing the plugin's previous
   * generation. Validation is atomic: any error rejects the whole set and
   * leaves the previous generation untouched.
   */
  activateGeneration(
    pluginId: string,
    generationId: string,
    contributions: readonly Contribution[]
  ): void {
    // --- validate (no side effects) -----------------------------------------
    const seen = new Set<string>();
    for (const contribution of contributions) {
      const slot = getSlot(contribution.slot);
      if (!slot) {
        throw new ContributionError(
          "unknown_slot",
          `plugin ${pluginId} contributes to unknown slot ${contribution.slot}`
        );
      }
      const key = `${contribution.slot}/${contribution.contributionId}`;
      if (seen.has(key)) {
        throw new ContributionError(
          "duplicate_contribution",
          `plugin ${pluginId} duplicates contribution ${key}`
        );
      }
      seen.add(key);
    }

    // --- retire previous generation ------------------------------------------
    const previous = this.#active.get(pluginId);
    if (previous) {
      for (const contribution of previous.contributions) {
        contribution.cleanup?.();
      }
    }

    // --- install --------------------------------------------------------------
    this.#active.set(pluginId, {
      contributions: [...contributions].sort((a, b) =>
        `${a.slot}/${a.contributionId}`.localeCompare(
          `${b.slot}/${b.contributionId}`
        )
      ),
      generationId,
    });
  }

  /** Remove a plugin entirely (disable / revoke), running all cleanups. */
  retirePlugin(pluginId: string): boolean {
    const previous = this.#active.get(pluginId);
    if (!previous) {
      return false;
    }
    for (const contribution of previous.contributions) {
      contribution.cleanup?.();
    }
    return this.#active.delete(pluginId);
  }

  activeGeneration(pluginId: string): string | undefined {
    return this.#active.get(pluginId)?.generationId;
  }

  /**
   * Deterministic cross-plugin view: keyed maps and sorted lists, stable
   * regardless of activation order.
   */
  view(): RegistryView {
    const keyed = new Map<string, Map<string, unknown>>();
    const lists = new Map<string, unknown[]>();
    const entries = [...this.#active.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [, generation] of entries) {
      for (const contribution of generation.contributions) {
        applyContribution(keyed, lists, contribution);
      }
    }
    return { keyed, lists };
  }

  get pluginCount(): number {
    return this.#active.size;
  }
}
