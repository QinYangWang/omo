import {
  type AbortCommand,
  AbortCommandSchema,
  type AcceptedOperation,
  AcceptedOperationSchema,
  type AddProjectCommand,
  AddProjectCommandSchema,
  type AgentEventEnvelope,
  AgentEventEnvelopeSchema,
  HostApiContracts,
  type HostHealth,
  HostHealthSchema,
  OkResponseSchema,
  type OpenSessionCommand,
  OpenSessionCommandSchema,
  type OpenSessionResponse,
  OpenSessionResponseSchema,
  type Project,
  ProjectListSchema,
  type PromptCommand,
  PromptCommandSchema,
  parseContract,
  SessionListSchema,
  type SessionSummary,
} from "@omo/contracts";

export interface SessionEventSubscription {
  close: () => void;
}

export interface HostClient<TSessionSnapshot = OpenSessionResponse> {
  abort: (command: AbortCommand) => Promise<void>;
  addProject: (command: AddProjectCommand) => Promise<Project>;
  health: () => Promise<HostHealth>;
  listProjects: () => Promise<Project[]>;
  listSessions: (cwd: string) => Promise<SessionSummary[]>;
  openSession: (command: OpenSessionCommand) => Promise<TSessionSnapshot>;
  prompt: (command: PromptCommand) => Promise<AcceptedOperation>;
  subscribeSession: (
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void
  ) => SessionEventSubscription;
}

export interface HttpHostClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  reconnectDelayMs?: number;
  token?: string;
}

const TRAILING_SLASH_PATTERN = /\/$/;
const SSE_LINE_ENDINGS_PATTERN = /\r\n/g;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(TRAILING_SLASH_PATTERN, "");

const eventData = (block: string): string =>
  block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

export class HostRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.status = status;
  }
}

export class HttpHostClient implements HostClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #reconnectDelayMs: number;
  readonly #token: string;

  constructor(options: HttpHostClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#token = options.token ?? "";
  }

  async health(): Promise<HostHealth> {
    return parseContract(
      HostHealthSchema,
      await this.request(HostApiContracts.health.path),
      "HostHealth"
    );
  }

  async addProject(command: AddProjectCommand): Promise<Project> {
    const body = parseContract(
      AddProjectCommandSchema,
      command,
      "AddProjectCommand"
    );
    return parseContract(
      HostApiContracts.addProject.response,
      await this.request(HostApiContracts.addProject.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "Project"
    );
  }

  async listProjects(): Promise<Project[]> {
    return parseContract(
      ProjectListSchema,
      await this.request(HostApiContracts.listProjects.path),
      "ProjectList"
    );
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const query = new URLSearchParams({ cwd });
    return parseContract(
      SessionListSchema,
      await this.request(`${HostApiContracts.listSessions.path}?${query}`),
      "SessionList"
    );
  }

  async openSession(command: OpenSessionCommand): Promise<OpenSessionResponse> {
    const body = parseContract(
      OpenSessionCommandSchema,
      command,
      "OpenSessionCommand"
    );
    return parseContract(
      OpenSessionResponseSchema,
      await this.request(HostApiContracts.openSession.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "OpenSessionResponse"
    );
  }

  async prompt(command: PromptCommand): Promise<AcceptedOperation> {
    const body = parseContract(PromptCommandSchema, command, "PromptCommand");
    return parseContract(
      AcceptedOperationSchema,
      await this.request(HostApiContracts.prompt.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "AcceptedOperation"
    );
  }

  async abort(command: AbortCommand): Promise<void> {
    const body = parseContract(AbortCommandSchema, command, "AbortCommand");
    parseContract(
      OkResponseSchema,
      await this.request(HostApiContracts.abortSession.path, {
        body: JSON.stringify(body),
        method: "POST",
      }),
      "OkResponse"
    );
  }

  subscribeSession(
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void
  ): SessionEventSubscription {
    if (
      !(sessionId && Number.isSafeInteger(afterSequence) && afterSequence >= 0)
    ) {
      throw new Error("Session subscription requires a valid ID and sequence");
    }
    const controller = new AbortController();
    this.runEventStream(sessionId, afterSequence, listener, controller).catch(
      () => undefined
    );
    return { close: () => controller.abort() };
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
    };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init?.headers },
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : `Host request failed (${response.status})`;
      throw new HostRequestError(response.status, message);
    }
    return value;
  }

  private async runEventStream(
    sessionId: string,
    initialSequence: number,
    listener: (event: AgentEventEnvelope) => void,
    controller: AbortController
  ): Promise<void> {
    let afterSequence = initialSequence;
    const deliver = (event: AgentEventEnvelope): void => {
      // Track the highest delivered sequence outside the per-connection read
      // so an abrupt disconnect resumes from it instead of replaying what
      // was already delivered.
      if (event.sequence > afterSequence) {
        afterSequence = event.sequence;
      }
      listener(event);
    };
    while (!controller.signal.aborted) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: reconnects are sequential.
        await this.readEventStream(
          sessionId,
          afterSequence,
          deliver,
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof HostRequestError && error.status === 401) {
          return;
        }
      }
      if (!controller.signal.aborted) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.#reconnectDelayMs)
        );
      }
    }
  }

  private async readEventStream(
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void,
    signal: AbortSignal
  ): Promise<number> {
    const query = new URLSearchParams({
      after: String(afterSequence),
      sessionId,
    });
    const response = await this.#fetch(
      `${this.#baseUrl}${HostApiContracts.sessionEvents.path}?${query}`,
      { headers: this.headers(), signal }
    );
    if (!(response.ok && response.body)) {
      throw new HostRequestError(
        response.status,
        `Host event stream failed (${response.status})`
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let cursor = afterSequence;
    while (!signal.aborted) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks are ordered.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder
        .decode(value, { stream: true })
        .replace(SSE_LINE_ENDINGS_PATTERN, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = eventData(block);
        if (data) {
          const event = parseContract(
            AgentEventEnvelopeSchema,
            JSON.parse(data),
            "AgentEventEnvelope"
          );
          if (event.sessionId !== sessionId) {
            throw new Error("Host event stream returned the wrong Session");
          }
          if (event.sequence > cursor) {
            cursor = event.sequence;
            listener(event);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return cursor;
  }
}
