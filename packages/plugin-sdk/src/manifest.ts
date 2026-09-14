import type { Static } from "typebox";
import { Type } from "typebox";

/**
 * Plugin manifest (plan §7.2). omo-owned product metadata on top of Chord's
 * `chord.facets` build entries. Integrity hashes prove artifact identity and
 * enable exact recovery; they are not a trust proof (§7.7).
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export const CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "network.egress",
  "process.spawn",
  "provider.invoke",
  "session.read",
  "session.write",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ContributionDeclarationSchema = Type.Object({
  /** Slot id or conversation node kind contributed. */
  contributionId: Type.String({ minLength: 1 }),
  /** e.g. "conversation.node", "workspace.panel" (see @omo/plugin-sdk slots). */
  slot: Type.String({ minLength: 1 }),
});
export type ContributionDeclaration = Static<
  typeof ContributionDeclarationSchema
>;

export const PluginManifestSchema = Type.Object({
  /** sha256 of the built artifact set (immutable generation identity). */
  artifactHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  /** Resource budgets; enforced by the plugin host. */
  budgets: Type.Optional(
    Type.Object({
      cpuMs: Type.Optional(Type.Integer({ minimum: 1 })),
      maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
      memoryMb: Type.Optional(Type.Integer({ minimum: 1 })),
      outputBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    })
  ),
  capabilities: Type.Array(Type.String({ minLength: 1 })),
  contributions: Type.Array(ContributionDeclarationSchema),
  /** Chord bundle entry names per facet target (browser/node). */
  entries: Type.Record(Type.String(), Type.String()),
  pluginId: Type.String({ minLength: 1 }),
  schemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
  /** Compatible @omo/plugin-sdk semver range, e.g. "^0.0.0". */
  sdkRange: Type.String({ minLength: 1 }),
  /** sha256 of source + lockfile + build inputs (provenance record). */
  sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  version: Type.String({ minLength: 1 }),
});
export type PluginManifest = Static<typeof PluginManifestSchema>;

/** One immutable plugin generation: manifest + resolved artifacts. */
export interface PluginGeneration {
  /** Content-addressed generation id, e.g. `gen_${artifactHash[:12]}`. */
  readonly generationId: string;
  readonly manifest: PluginManifest;
  readonly pluginId: string;
}
