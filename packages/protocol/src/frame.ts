import type { Static } from "typebox";
import { Type } from "typebox";
import { FRAME_SCHEMA_VERSION, OMO_PROTOCOL_VERSION } from "./version.ts";

/**
 * Wire frame envelope (plan §6.3). One WebSocket control connection carries
 * multiplexed frames for many sessions, tasks and interactions (§6.2).
 *
 * Sequence domains are deliberately separated: storage commit sequence, omo
 * replay cursor and per-subscription publication sequence never have to be
 * numerically equal. Cross-language integers travel as decimal strings.
 */

export const CursorSchema = Type.String({ pattern: "^(0|[1-9][0-9]*)$" });
export type Cursor = Static<typeof CursorSchema>;

export const ResetRequiredSchema = Type.Object({
  /** Last durable cursor the client provably applied, decimal string. */
  appliedCursor: Type.Optional(CursorSchema),
  reason: Type.Union([
    Type.Literal("cursor_expired"),
    Type.Literal("epoch_changed"),
    Type.Literal("codec_mismatch"),
    Type.Literal("gap_detected"),
    Type.Literal("payload_schema_unsupported"),
  ]),
});
export type ResetRequired = Static<typeof ResetRequiredSchema>;

export const FrameSchema = Type.Object({
  /** Writer/owner epoch; stale epochs are rejected at write boundaries. */
  bindingEpoch: Type.Optional(CursorSchema),
  commandId: Type.Optional(Type.String({ minLength: 1 })),
  /** Replay cursor of the carried payload, when durable. */
  cursor: Type.Optional(CursorSchema),
  kind: Type.String({ minLength: 1 }),
  laneId: Type.Optional(Type.String({ minLength: 1 })),
  payload: Type.Unknown(),
  payloadSchemaVersion: Type.Literal(FRAME_SCHEMA_VERSION),
  protocolVersion: Type.Literal(OMO_PROTOCOL_VERSION),
  /** Per-subscription continuous sequence (plan §6.4 filtered lanes). */
  publicationSequence: Type.Optional(CursorSchema),
  /** One transport call identity. Never reused as a business commandId. */
  requestId: Type.Optional(Type.String({ minLength: 1 })),
  /** Persistent logical daemon identity; not a URL (plan §6.3). */
  serverId: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  subscriptionId: Type.Optional(Type.String({ minLength: 1 })),
  workspaceId: Type.Optional(Type.String({ minLength: 1 })),
});
export type Frame = Static<typeof FrameSchema>;

export const incrementCursor = (cursor: Cursor): Cursor =>
  (BigInt(cursor) + 1n).toString(10) as Cursor;

export const compareCursors = (a: Cursor, b: Cursor): number => {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};
