import { randomUUID } from "node:crypto";

/**
 * Stable product identity types (plan §3.5, §5.1).
 *
 * Every id is a prefixed lowercase string so logs, receipts and audits can
 * tell identities apart without a schema. New ids are generated locally with
 * a UUID; the prefix is part of the id and is validated by the wire schemas.
 */

declare const brand: unique symbol;

export type Brand<TName extends string> = string & { readonly [brand]: TName };

export type UserId = Brand<"UserId">;
export type DeviceId = Brand<"DeviceId">;
export type WorkspaceId = Brand<"WorkspaceId">;
export type SessionId = Brand<"SessionId">;
export type LaneId = Brand<"LaneId">;
export type CommandId = Brand<"CommandId">;
export type OperationId = Brand<"OperationId">;
export type InteractionId = Brand<"InteractionId">;
export type PluginId = Brand<"PluginId">;
export type ArtifactId = Brand<"ArtifactId">;
export type SubscriptionId = Brand<"SubscriptionId">;
/** Persistent logical daemon identity. Not a URL (plan §6.3). */
export type ServerId = Brand<"ServerId">;

const PREFIX = {
  artifact: "art",
  command: "cmd",
  device: "dev",
  interaction: "int",
  lane: "lane",
  operation: "op",
  plugin: "plg",
  server: "srv",
  session: "ses",
  subscription: "sub",
  user: "usr",
  workspace: "wks",
} as const;

export const ID_PREFIXES = PREFIX;

const createId = <T extends Brand<string>>(prefix: string): T =>
  `${prefix}_${randomUUID()}` as T;

export const newUserId = (): UserId => createId<UserId>(PREFIX.user);
export const newDeviceId = (): DeviceId => createId<DeviceId>(PREFIX.device);
export const newWorkspaceId = (): WorkspaceId =>
  createId<WorkspaceId>(PREFIX.workspace);
export const newSessionId = (): SessionId =>
  createId<SessionId>(PREFIX.session);
export const newCommandId = (): CommandId =>
  createId<CommandId>(PREFIX.command);
export const newOperationId = (): OperationId =>
  createId<OperationId>(PREFIX.operation);
export const newInteractionId = (): InteractionId =>
  createId<InteractionId>(PREFIX.interaction);
export const newPluginId = (): PluginId => createId<PluginId>(PREFIX.plugin);
export const newArtifactId = (): ArtifactId =>
  createId<ArtifactId>(PREFIX.artifact);
export const newSubscriptionId = (): SubscriptionId =>
  createId<SubscriptionId>(PREFIX.subscription);
export const newServerId = (): ServerId => createId<ServerId>(PREFIX.server);

/** A lane id is the Session-local lane name, branded for call-site clarity. */
export const asLaneId = (name: string): LaneId => name as LaneId;

/** Type-checked cast for ids read from durable storage or the wire. */
export const asId = <T extends Brand<string>>(value: string): T => value as T;
