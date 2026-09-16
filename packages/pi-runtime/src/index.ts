import path from "node:path";
import {
  type AgentSession,
  createAgentSession,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
export interface OpenPiSessionInput {
  cwd: string;
  sessionPath?: string;
}

export interface PiSessionLease {
  release: () => Promise<void>;
  readonly session: unknown;
}

export interface PiSkillSummary {
  description: string;
  filePath: string;
  name: string;
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

const defaultTools = (): string[] =>
  process.platform === "win32"
    ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls"];

export class PiRuntimeAdapter {
  readonly #sessions = new Set<AgentSession>();
  #modelRuntime: Promise<ModelRuntime> | undefined;
  readonly #lifecycle: { closed: boolean } = { closed: false };

  async openSession(input: OpenPiSessionInput): Promise<PiSessionLease> {
    if (this.#lifecycle.closed) {
      throw new Error("Pi runtime is closed");
    }
    const document = input.sessionPath
      ? SessionManager.open(input.sessionPath)
      : SessionManager.create(input.cwd);
    const result = await createAgentSession({
      cwd: input.cwd,
      modelRuntime: await this.getInternalModelRuntime(),
      sessionManager: document,
      tools: defaultTools(),
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

  listSkills(agentDir: string): PiSkillSummary[] {
    return loadSkillsFromDir({
      dir: path.join(agentDir, "skills"),
      source: "user",
    }).skills.map((skill) => ({
      description: skill.description,
      filePath: skill.filePath,
      name: skill.name,
    }));
  }

  openSessionDocument(sessionPath: string): unknown {
    return SessionManager.open(sessionPath);
  }

  forkSession(sourcePath: string, cwd: string): string {
    const sessionFile = SessionManager.forkFrom(
      sourcePath,
      cwd
    ).getSessionFile();
    if (!sessionFile) {
      throw new Error("Forked Session did not create a Session file");
    }
    return sessionFile;
  }

  renameSession(sessionPath: string, name: string): void {
    SessionManager.open(sessionPath).appendSessionInfo(name);
  }

  cloneSession(sessionPath: string): string {
    const document = SessionManager.open(sessionPath);
    const leafId = document.getLeafId();
    if (!leafId) {
      throw new Error("Cannot clone an empty Session");
    }
    const sessionFile = document.createBranchedSession(leafId);
    if (!sessionFile) {
      throw new Error("Cloned Session did not create a Session file");
    }
    return sessionFile;
  }

  getModelRuntime(): Promise<unknown> {
    return this.getInternalModelRuntime();
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

  private getInternalModelRuntime(): Promise<ModelRuntime> {
    if (this.#lifecycle.closed) {
      return Promise.reject(new Error("Pi runtime is closed"));
    }
    this.#modelRuntime ??= ModelRuntime.create();
    return this.#modelRuntime;
  }
}
