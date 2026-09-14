/**
 * Host-declared slots (plan §7.10). The first version keeps the list short on
 * purpose; new slots require a protocol bump and host support on every target.
 */

export const SLOT_SCOPES = ["session", "workspace", "plugin"] as const;
export type SlotScope = (typeof SLOT_SCOPES)[number];

export interface SlotDefinition {
  readonly cardinality: "keyed" | "list";
  readonly description: string;
  readonly scope: SlotScope;
  readonly slotId: string;
}

export const SLOTS: readonly SlotDefinition[] = [
  {
    cardinality: "keyed",
    description: "Render a business row or tool result by node kind.",
    scope: "session",
    slotId: "conversation.node",
  },
  {
    cardinality: "list",
    description: "Session-level actions in the conversation header.",
    scope: "session",
    slotId: "conversation.header.actions",
  },
  {
    cardinality: "list",
    description:
      "Composer actions that submit explicit commands; never take over editor state.",
    scope: "session",
    slotId: "composer.actions",
  },
  {
    cardinality: "list",
    description: "Workspace panels / task views.",
    scope: "workspace",
    slotId: "workspace.panel",
  },
  {
    cardinality: "keyed",
    description: "Per-plugin settings form with revisioned saves.",
    scope: "plugin",
    slotId: "settings.plugin",
  },
] as const;

export const getSlot = (slotId: string): SlotDefinition | undefined =>
  SLOTS.find((slot) => slot.slotId === slotId);
