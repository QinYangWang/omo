import type { Static } from "typebox";
import { Type } from "typebox";

/**
 * Conversation node protocol (plan §7.0, §7.6).
 *
 * Business facts about one plugin-owned entity travel as start / update /
 * terminal records keyed by a stable identity (plugin + kind + entity id).
 * Live append, history pagination (prepend) and full replay of the same
 * facts MUST produce the same final view model — the assembler in
 * `@omo/plugin-sdk` owns that reduction; renderers never walk raw logs.
 */

export const NODE_SCHEMA_VERSION = 1;

export const NodeIdentitySchema = Type.Object({
  /** Stable business entity id, unchanged across hot updates (§7.10). */
  entityId: Type.String({ minLength: 1 }),
  /** Plugin-declared node kind, e.g. "progress-card". */
  kind: Type.String({ minLength: 1 }),
  /** Plugin that owns this node kind. */
  pluginId: Type.String({ minLength: 1 }),
});
export type NodeIdentity = Static<typeof NodeIdentitySchema>;

export const NODE_FACT_TYPES = ["start", "update", "terminal"] as const;
export type NodeFactType = (typeof NODE_FACT_TYPES)[number];

/** One persisted business fact about an entity (already durably committed). */
export const NodeFactSchema = Type.Object({
  /** RFC 3339 timestamp. */
  at: Type.String({ format: "date-time" }),
  /** Monotonic per-entity sequence assigned by the plugin's backend facet. */
  entitySeq: Type.Integer({ minimum: 0 }),
  factType: Type.Union([
    Type.Literal("start"),
    Type.Literal("update"),
    Type.Literal("terminal"),
  ]),
  /** Plugin generation that emitted the fact; renderer compat is checked. */
  generation: Type.String({ minLength: 1 }),
  identity: NodeIdentitySchema,
  payload: Type.Unknown(),
  /** Payload schema version the payload conforms to (per plugin kind). */
  payloadVersion: Type.Integer({ minimum: 1 }),
});
export type NodeFact = Static<typeof NodeFactSchema>;

/**
 * Target-neutral view model produced by the assembler and consumed by keyed
 * renderers. `status` reflects fact flow, not business semantics:
 *  - pending: updates arrived before their start (tail-only history window);
 *  - open: started, not yet terminal;
 *  - settled: terminal fact applied; streaming state has been REPLACED, never
 *    concatenated again (§7.0 settlement rule).
 */
export const NODE_VIEW_STATES = ["pending", "open", "settled"] as const;
export type NodeViewState = (typeof NODE_VIEW_STATES)[number];

export interface NodeViewModel<TPayload = unknown> {
  /** Facts folded so far, for diagnostics and replay verification. */
  readonly appliedFacts: number;
  /** Generation of the latest folded fact. */
  readonly generation: string;
  readonly identity: NodeIdentity;
  /** Highest entitySeq folded. */
  readonly lastEntitySeq: number;
  readonly payload: TPayload | undefined;
  /** Schema version of the settled/initial payload the renderer receives. */
  readonly payloadVersion: number;
  readonly state: NodeViewState;
}

/**
 * Renderer-facing contract: given a view model, produce a declarative
 * component tree (or null to hide the node). Renderers must declare the
 * payload versions they can read; incompatible payloads fall back to text.
 */
export interface NodeRenderer {
  readonly kind: string;
  readonly payloadVersions: readonly number[];
  readonly pluginId: string;
  readonly render: (view: NodeViewModel) => unknown; // ComponentNode, typed at the UI layer
}
