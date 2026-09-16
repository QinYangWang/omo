import type {
  AbortCommand,
  AcceptedOperation,
  AgentEventEnvelope,
  HostHealth,
  OpenSessionCommand,
  Project,
  PromptCommand,
  SessionSummary,
} from "@omo/contracts";

export interface SessionEventSubscription {
  close: () => void;
}

export interface HostClient<TSessionSnapshot = unknown> {
  abort: (command: AbortCommand) => Promise<void>;
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
