import type {
  JsonValue,
  OpenSessionCommand,
  Project,
  SessionSummary,
} from "@omo/contracts";

export interface WorkspacePort {
  resolveExisting: (path: string) => Promise<string>;
  readonly roots: readonly string[];
}

export interface ProjectRepositoryPort {
  list: () => Promise<Project[]>;
  replace: (projects: readonly Project[]) => Promise<void>;
}

export interface OperationPutResult {
  readonly inserted: boolean;
  readonly result: JsonValue;
}

export interface OperationRepositoryPort {
  get: (operationId: string) => Promise<JsonValue | undefined>;
  putIfAbsent: (
    operationId: string,
    result: JsonValue
  ) => Promise<OperationPutResult>;
}

export interface SessionRuntimePort {
  abort: () => Promise<void>;
  close: () => Promise<void>;
  readonly isStreaming: boolean;
  prompt: (message: string) => Promise<void>;
  readonly sessionId: string;
  readonly sessionPath?: string;
  subscribe: (listener: (event: JsonValue) => void) => () => void;
}

export interface PiRuntimePort {
  listSessions: (cwd: string) => Promise<SessionSummary[]>;
  openSession: (input: OpenSessionCommand) => Promise<SessionRuntimePort>;
}

export interface AddProjectInput {
  cwd: string;
  name?: string;
}

export type CreateId = () => string;

export class WorkspaceService {
  readonly port: WorkspacePort;

  constructor(port: WorkspacePort) {
    this.port = port;
  }

  resolveExisting(path: string): Promise<string> {
    return this.port.resolveExisting(path);
  }

  containsRoot(path: string): boolean {
    return this.port.roots.includes(path);
  }
}

const PATH_SEPARATOR_PATTERN = /[\\/]/;

export class ProjectService {
  readonly createId: CreateId;
  readonly repository: ProjectRepositoryPort;
  readonly workspace: WorkspaceService;

  constructor(
    repository: ProjectRepositoryPort,
    workspace: WorkspaceService,
    createId: CreateId
  ) {
    this.createId = createId;
    this.repository = repository;
    this.workspace = workspace;
  }

  list(): Promise<Project[]> {
    return this.repository.list();
  }

  async add(input: AddProjectInput): Promise<Project> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    const projects = await this.repository.list();
    const existing = projects.find((candidate) => candidate.cwd === cwd);
    if (existing) {
      return existing;
    }
    const project = {
      cwd,
      id: this.createId(),
      name:
        input.name?.trim() || cwd.split(PATH_SEPARATOR_PATTERN).at(-1) || cwd,
    };
    await this.repository.replace([...projects, project]);
    return project;
  }
}

export class OperationLedger {
  readonly repository: OperationRepositoryPort;

  constructor(repository: OperationRepositoryPort) {
    this.repository = repository;
  }

  async accept<T extends JsonValue>(
    operationId: string,
    result: T,
    dispatch: () => Promise<void>
  ): Promise<T> {
    const existing = await this.repository.get(operationId);
    if (existing !== undefined) {
      return existing as T;
    }
    const accepted = await this.repository.putIfAbsent(operationId, result);
    if (accepted.inserted) {
      await dispatch();
    }
    return accepted.result as T;
  }
}

interface ManagedSession {
  attachments: number;
  readonly runtime: SessionRuntimePort;
}

export interface SessionAttachment {
  detach: () => void;
  readonly runtime: SessionRuntimePort;
}

const sessionPathKey = (sessionPath: string): string => `path:${sessionPath}`;
const sessionIdKey = (sessionId: string): string => `id:${sessionId}`;

export class SessionCoordinator {
  readonly runtime: PiRuntimePort;
  readonly #sessions = new Map<string, Promise<ManagedSession>>();
  readonly #managed = new Set<ManagedSession>();

  constructor(runtime: PiRuntimePort) {
    this.runtime = runtime;
  }

  async attach(input: OpenSessionCommand): Promise<SessionAttachment> {
    const requestedKeys = [sessionIdKey(input.sessionId)];
    if (input.sessionPath) {
      requestedKeys.unshift(sessionPathKey(input.sessionPath));
    }
    const existing = requestedKeys
      .map((key) => this.#sessions.get(key))
      .find((session) => session !== undefined);
    const opening = existing ?? this.open(input);
    for (const key of requestedKeys) {
      this.#sessions.set(key, opening);
    }
    const managed = await opening;
    managed.attachments += 1;
    this.#sessions.set(sessionIdKey(managed.runtime.sessionId), opening);
    if (managed.runtime.sessionPath) {
      this.#sessions.set(sessionPathKey(managed.runtime.sessionPath), opening);
    }
    let attached = true;
    return {
      detach: () => {
        if (!attached) {
          return;
        }
        attached = false;
        managed.attachments = Math.max(0, managed.attachments - 1);
      },
      runtime: managed.runtime,
    };
  }

  list(cwd: string): Promise<SessionSummary[]> {
    return this.runtime.listSessions(cwd);
  }

  async close(): Promise<void> {
    const managed = [...this.#managed];
    this.#managed.clear();
    this.#sessions.clear();
    const results = await Promise.allSettled(
      managed.map(({ runtime }) => runtime.close())
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close Session runtimes");
    }
  }

  private open(input: OpenSessionCommand): Promise<ManagedSession> {
    const opening = this.runtime.openSession(input).then((runtime) => {
      const managed = { attachments: 0, runtime };
      this.#managed.add(managed);
      return managed;
    });
    opening.catch(() => {
      for (const [key, candidate] of this.#sessions) {
        if (candidate === opening) {
          this.#sessions.delete(key);
        }
      }
    });
    return opening;
  }
}
