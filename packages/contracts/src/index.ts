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

export const OkResponseSchema = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false }
);
export type OkResponse = Static<typeof OkResponseSchema>;

export const ProjectSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type Project = Static<typeof ProjectSchema>;

export const ProjectListSchema = Type.Array(ProjectSchema);
export type ProjectList = Static<typeof ProjectListSchema>;

export const AddProjectCommandSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type AddProjectCommand = Static<typeof AddProjectCommandSchema>;

export const SessionSummarySchema = Type.Object(
  {
    allMessagesText: Type.String(),
    created: Type.Number(),
    cwd: Type.String(),
    firstMessage: Type.String(),
    id: Type.String({ minLength: 1 }),
    messageCount: Type.Integer({ minimum: 0 }),
    modified: Type.Number(),
    name: Type.Optional(Type.String()),
    parentSessionPath: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type SessionSummary = Static<typeof SessionSummarySchema>;

export const SessionListQuerySchema = Type.Object(
  { cwd: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);
export type SessionListQuery = Static<typeof SessionListQuerySchema>;

export const SessionListSchema = Type.Array(SessionSummarySchema);
export type SessionList = Static<typeof SessionListSchema>;

export const OpenSessionCommandSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionPath: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type OpenSessionCommand = Static<typeof OpenSessionCommandSchema>;

export const ContextUsageSchema = Type.Object(
  {
    contextWindow: Type.Number({ minimum: 0 }),
    percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type ContextUsage = Static<typeof ContextUsageSchema>;

export const SessionModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type SessionModel = Static<typeof SessionModelSchema>;

export const SessionOutlineItemSchema = Type.Object(
  {
    absoluteIndex: Type.Integer({ minimum: 0 }),
    id: Type.String({ minLength: 1 }),
    userPreview: Type.String(),
  },
  { additionalProperties: true }
);
export type SessionOutlineItem = Static<typeof SessionOutlineItemSchema>;

export const OpenSessionResponseSchema = Type.Object(
  {
    contextUsage: Type.Union([ContextUsageSchema, Type.Null()]),
    cursor: Type.Integer({ minimum: 0 }),
    eventSequence: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
    isStreaming: Type.Boolean(),
    messages: Type.Array(JsonValueSchema),
    model: Type.Union([SessionModelSchema, Type.Null()]),
    outline: Type.Optional(Type.Array(SessionOutlineItemSchema)),
    replayFromSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionFile: Type.Optional(Type.String({ minLength: 1 })),
    sessionId: Type.String({ minLength: 1 }),
    thinkingLevel: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type OpenSessionResponse = Static<typeof OpenSessionResponseSchema>;

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
    cwd: Type.Optional(Type.String({ minLength: 1 })),
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

export const EventStreamQuerySchema = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type EventStreamQuery = Static<typeof EventStreamQuerySchema>;

export const HostApiContracts = {
  abortSession: {
    body: AbortCommandSchema,
    method: "POST",
    path: "/api/v1/pi/abort",
    response: OkResponseSchema,
  },
  addProject: {
    body: AddProjectCommandSchema,
    method: "POST",
    path: "/api/v1/projects",
    response: ProjectSchema,
  },
  health: {
    method: "GET",
    path: "/api/v1/health",
    response: HostHealthSchema,
  },
  listProjects: {
    method: "GET",
    path: "/api/v1/projects",
    response: ProjectListSchema,
  },
  listSessions: {
    method: "GET",
    path: "/api/v1/sessions",
    query: SessionListQuerySchema,
    response: SessionListSchema,
  },
  openSession: {
    body: OpenSessionCommandSchema,
    method: "POST",
    path: "/api/v1/pi/open",
    response: OpenSessionResponseSchema,
  },
  prompt: {
    body: PromptCommandSchema,
    method: "POST",
    path: "/api/v1/pi/prompt",
    response: AcceptedOperationSchema,
  },
  sessionEvents: {
    event: AgentEventEnvelopeSchema,
    method: "GET",
    path: "/api/v1/events",
    query: EventStreamQuerySchema,
  },
} as const;

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
