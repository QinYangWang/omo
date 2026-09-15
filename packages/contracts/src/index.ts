import { type Static, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const HOST_ID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const HostIdSchema = Type.String({ pattern: HOST_ID_PATTERN });
export type HostId = Static<typeof HostIdSchema>;

export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue"
);
export type JsonValue = Static<typeof JsonValueSchema>;

export const HostHealthSchema = Type.Object(
  {
    capabilities: Type.Array(Type.String()),
    hostId: HostIdSchema,
    ok: Type.Literal(true),
    protocolVersion: Type.Integer({ minimum: 1 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export type HostHealth = Static<typeof HostHealthSchema>;

export const ProjectSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type Project = Static<typeof ProjectSchema>;

export const SessionSummarySchema = Type.Object(
  {
    created: Type.Number(),
    cwd: Type.String({ minLength: 1 }),
    firstMessage: Type.Optional(Type.String()),
    id: Type.String({ minLength: 1 }),
    modified: Type.Number(),
    name: Type.Optional(Type.String()),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);
export type SessionSummary = Static<typeof SessionSummarySchema>;

export const OpenSessionCommandSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionPath: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type OpenSessionCommand = Static<typeof OpenSessionCommandSchema>;

export const ImageAttachmentSchema = Type.Object(
  {
    data: Type.String({ maxLength: 8_000_000 }),
    mimeType: Type.String({ pattern: "^image/" }),
    type: Type.Literal("image"),
  },
  { additionalProperties: false }
);
export type ImageAttachment = Static<typeof ImageAttachmentSchema>;

export const PromptCommandSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    images: Type.Optional(Type.Array(ImageAttachmentSchema, { maxItems: 8 })),
    message: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionPath: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type PromptCommand = Static<typeof PromptCommandSchema>;

export const AbortCommandSchema = Type.Object(
  {
    requestId: Type.Optional(Type.String({ minLength: 1 })),
    sessionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type AbortCommand = Static<typeof AbortCommandSchema>;

export const AcceptedOperationSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    sessionFile: Type.Optional(Type.String({ minLength: 1 })),
    sessionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type AcceptedOperation = Static<typeof AcceptedOperationSchema>;

export const AgentEventEnvelopeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    payload: JsonValueSchema,
    sequence: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    timestamp: Type.Number(),
    type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type AgentEventEnvelope = Static<typeof AgentEventEnvelopeSchema>;

export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly string[];

  constructor(contract: string, issues: readonly string[]) {
    super(`Invalid ${contract}: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = issues;
  }
}

export function parseContract<T extends TSchema>(
  schema: T,
  value: unknown,
  contract: string
): Static<T> {
  if (Check(schema, value)) {
    return value as Static<T>;
  }
  const issues = [...Errors(schema, value)].map((error) => error.message);
  throw new ContractValidationError(contract, issues);
}
