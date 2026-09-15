import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";

export const PI_UPSTREAM_VERSION = "0.85.0" as const;

export const PI_RUNTIME_CAPABILITIES = Object.freeze({
  agentSessionRuntime: typeof createAgentSessionRuntime === "function",
  codingAgentPresentationFacets: false,
  multiPresentationProtocol: true,
  protocolVersion: PROTOCOL_VERSION,
  sessionBackendSqlite: true,
  stableAgentSessionSdk: true,
  upstreamVersion: PI_UPSTREAM_VERSION,
});

export type PiRuntimeCapabilities = typeof PI_RUNTIME_CAPABILITIES;

type CodingTools = NonNullable<CreateAgentSessionOptions["tools"]>;

export interface OpenPiSessionInput {
  cwd: string;
  sessionPath?: string;
  tools?: CodingTools;
}

export interface PiSessionLease {
  release: () => Promise<void>;
  readonly result: CreateAgentSessionResult;
  readonly session: AgentSession;
}

export interface PiSessionSummary {
  created: Date;
  cwd: string;
  firstMessage: string;
  id: string;
  modified: Date;
  name?: string;
  path: string;
}

const defaultTools = (): CodingTools =>
  process.platform === "win32"
    ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls"];

export class PiRuntimeAdapter {
  readonly capabilities = PI_RUNTIME_CAPABILITIES;
  readonly #sessions = new Set<AgentSession>();
  #modelRuntime: Promise<ModelRuntime> | undefined;
  readonly #lifecycle: { closed: boolean } = { closed: false };

  async openSession(input: OpenPiSessionInput): Promise<PiSessionLease> {
    if (this.#lifecycle.closed) {
      throw new Error("Pi runtime is closed");
    }
    const result = await createAgentSession({
      cwd: input.cwd,
      modelRuntime: await this.getModelRuntime(),
      sessionManager: input.sessionPath
        ? SessionManager.open(input.sessionPath)
        : SessionManager.create(input.cwd),
      tools: input.tools ?? defaultTools(),
    });
    const { session } = result;
    this.#sessions.add(session);
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.#sessions.delete(session);
        if (session.isStreaming) {
          await session.abort();
        }
        session.dispose();
      },
      result,
      session,
    };
  }

  async listSessions(cwd: string): Promise<PiSessionSummary[]> {
    return (await SessionManager.list(cwd)).map((session) => ({
      created: session.created,
      cwd: session.cwd,
      firstMessage: session.firstMessage,
      id: session.id,
      modified: session.modified,
      name: session.name,
      path: session.path,
    }));
  }

  async listAllSessions(): Promise<PiSessionSummary[]> {
    return (await SessionManager.listAll()).map((session) => ({
      created: session.created,
      cwd: session.cwd,
      firstMessage: session.firstMessage,
      id: session.id,
      modified: session.modified,
      name: session.name,
      path: session.path,
    }));
  }

  getModelRuntime(): Promise<ModelRuntime> {
    if (this.#lifecycle.closed) {
      return Promise.reject(new Error("Pi runtime is closed"));
    }
    this.#modelRuntime ??= ModelRuntime.create();
    return this.#modelRuntime;
  }

  async close(): Promise<void> {
    if (this.#lifecycle.closed) {
      return;
    }
    this.#lifecycle.closed = true;
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    const cleanupResults = await Promise.allSettled(
      sessions.map(async (session) => {
        if (session.isStreaming) {
          await session.abort();
        }
        session.dispose();
      })
    );
    const errors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close Pi runtime sessions");
    }
  }
}
