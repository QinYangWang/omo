import type { JsonValue, Project } from "@omo/contracts";

export interface WorkspacePort {
  resolveExisting: (path: string) => Promise<string>;
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
