import type { Static } from "typebox";
import { Type } from "typebox";

/**
 * Declarative UI component protocol (plan §7.6, §7.10).
 *
 * A bounded, versioned component vocabulary rendered by every client host
 * (Web today, RN/RNOH later). Plugins express UI as data; hosts map kinds to
 * their own controls. Unknown kinds degrade to a read-only text fallback —
 * a failed or old renderer must never corrupt the surrounding session.
 *
 * Actions are referenced by id only; invoking one produces a typed host
 * command, never direct Agent / filesystem access from a plugin surface.
 */

export const COMPONENT_SCHEMA_VERSION = 1;

const ActionRefSchema = Type.Object({
  /** Host-registered action id, namespaced by plugin. */
  actionId: Type.String({ minLength: 1 }),
  /** Optional payload merged into the command the host sends. */
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const BaseProps = {
  /** Optional stable key for keyed rendering lists. */
  key: Type.Optional(Type.String()),
};

const TextSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("text"),
  text: Type.String(),
  tone: Type.Optional(
    Type.Union([
      Type.Literal("default"),
      Type.Literal("muted"),
      Type.Literal("success"),
      Type.Literal("warning"),
      Type.Literal("error"),
    ])
  ),
});

const MarkdownSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("markdown"),
  markdown: Type.String(),
});

const StatusSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("status"),
  label: Type.String(),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
  ]),
});

const ProgressSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("progress"),
  label: Type.Optional(Type.String()),
  /** 0..1 */
  ratio: Type.Number({ maximum: 1, minimum: 0 }),
});

const InputSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("input"),
  label: Type.String(),
  name: Type.String({ minLength: 1 }),
  placeholder: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
});

const SelectSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("select"),
  label: Type.String(),
  name: Type.String({ minLength: 1 }),
  options: Type.Array(
    Type.Object({ label: Type.String(), value: Type.String() })
  ),
  value: Type.Optional(Type.String()),
});

const ConfirmSchema = Type.Object({
  ...BaseProps,
  action: ActionRefSchema,
  destructive: Type.Optional(Type.Boolean()),
  kind: Type.Literal("confirm"),
  label: Type.String(),
});

const TableSchema = Type.Object({
  ...BaseProps,
  columns: Type.Array(Type.String({ minLength: 1 })),
  kind: Type.Literal("table"),
  rows: Type.Array(Type.Array(Type.String())),
});

const DiffSchema = Type.Object({
  ...BaseProps,
  kind: Type.Literal("diff"),
  patch: Type.String(),
  path: Type.String(),
});

const ArtifactRefSchema = Type.Object({
  ...BaseProps,
  artifactId: Type.String({ minLength: 1 }),
  kind: Type.Literal("artifact_ref"),
  label: Type.Optional(Type.String()),
});

const ButtonSchema = Type.Object({
  ...BaseProps,
  action: ActionRefSchema,
  kind: Type.Literal("button"),
  label: Type.String(),
});

/**
 * Recursive component tree. Children only nest inside `stack` containers so
 * hosts can bound layout complexity; leaf components never contain UI.
 */
export const ComponentNodeSchema = Type.Union([
  TextSchema,
  MarkdownSchema,
  StatusSchema,
  ProgressSchema,
  InputSchema,
  SelectSchema,
  ConfirmSchema,
  TableSchema,
  DiffSchema,
  ArtifactRefSchema,
  ButtonSchema,
  Type.Object({
    ...BaseProps,
    children: Type.Array(Type.This()),
    direction: Type.Optional(
      Type.Union([Type.Literal("vertical"), Type.Literal("horizontal")])
    ),
    kind: Type.Literal("stack"),
  }),
]);
export type ComponentNode = Static<typeof ComponentNodeSchema>;

export const KNOWN_COMPONENT_KINDS = [
  "text",
  "markdown",
  "status",
  "progress",
  "input",
  "select",
  "confirm",
  "table",
  "diff",
  "artifact_ref",
  "button",
  "stack",
] as const;
export type KnownComponentKind = (typeof KNOWN_COMPONENT_KINDS)[number];

/** Read-only degradation for components a host cannot render (§7.6). */
export const fallbackComponent = (node: {
  readonly kind: string;
}): ComponentNode => ({
  kind: "text",
  text: `[unsupported component: ${node.kind}]`,
  tone: "muted",
});
