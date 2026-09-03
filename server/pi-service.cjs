"use strict";
const { displayMessages } = require("./display-messages.cjs");

const MAX_IMAGE_DATA_LENGTH = 8_000_000;

class PiService {
  constructor(eventStore, workspace, sessionWorkspace) {
    this.events = eventStore;
    this.workspace = workspace;
    this.sessionWorkspace = sessionWorkspace;
    this.sessions = new Map();
    this.history = new Map();
    this.authPrompts = new Map();
    this.sdk = import("@earendil-works/pi-coding-agent");
    this.runtimePromise = undefined;
  }

  async runtime() {
    const { ModelRuntime } = await this.sdk;
    this.runtimePromise ||= ModelRuntime.create();
    return this.runtimePromise;
  }

  async ensure(sessionId, cwd, sessionPath) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    const creating = (async () => {
      const resolvedCwd = await this.workspace.resolveExisting(cwd);
      const resolvedSessionPath = sessionPath
        ? await this.sessionWorkspace.resolveExisting(sessionPath)
        : undefined;
      const { createAgentSession, SessionManager } = await this.sdk;
      const modelRuntime = await this.runtime();
      const { session } = await createAgentSession({
        cwd: resolvedCwd,
        modelRuntime,
        sessionManager: resolvedSessionPath
          ? SessionManager.open(resolvedSessionPath)
          : SessionManager.create(resolvedCwd),
        tools:
          process.platform === "win32"
            ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
            : ["read", "bash", "edit", "write", "grep", "find", "ls"],
      });
      session.subscribe((event) => this.events.append(sessionId, event));
      return session;
    })();
    this.sessions.set(sessionId, creating);
    try {
      return await creating;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  async open({ sessionId, cwd, sessionPath }) {
    if (sessionPath) {
      const resolvedCwd = await this.workspace.resolveExisting(cwd);
      const resolvedSessionPath =
        await this.sessionWorkspace.resolveExisting(sessionPath);
      const { SessionManager } = await this.sdk;
      const manager = SessionManager.open(resolvedSessionPath);
      const all = displayMessages(manager.buildSessionContext().messages);
      this.history.set(sessionId, all);
      const cursor = Math.max(0, all.length - 80);
      const session = await this.ensure(
        sessionId,
        resolvedCwd,
        resolvedSessionPath
      );
      return {
        cursor,
        eventSequence: this.events.latestSequence(sessionId),
        hasMore: cursor > 0,
        messages: all.slice(cursor),
        model: session.model
          ? {
              id: session.model.id,
              name: session.model.name || session.model.id,
              provider: session.model.provider,
            }
          : null,
        sessionFile: resolvedSessionPath,
        sessionId: manager.getSessionId(),
        thinkingLevel: session.thinkingLevel,
      };
    }
    const session = await this.ensure(sessionId, cwd);
    return {
      cursor: 0,
      eventSequence: this.events.latestSequence(sessionId),
      hasMore: false,
      messages: [],
      model: session.model
        ? {
            id: session.model.id,
            name: session.model.name || session.model.id,
            provider: session.model.provider,
          }
        : null,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      thinkingLevel: session.thinkingLevel,
    };
  }

  historyPage(sessionId, before) {
    const all = this.history.get(sessionId) || [];
    const end = Math.max(0, Math.min(Number(before), all.length));
    const cursor = Math.max(0, end - 80);
    return { cursor, hasMore: cursor > 0, messages: all.slice(cursor, end) };
  }

  async models() {
    return (await (await this.runtime()).getAvailable()).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
    }));
  }

  async commands({ sessionId, cwd, sessionPath }) {
    const session = await this.ensure(sessionId, cwd, sessionPath);
    const extensions = session.extensionRunner
      .getRegisteredCommands()
      .map(({ invocationName, description }) => ({
        description,
        name: invocationName,
        source: "extension",
      }));
    const prompts = session.promptTemplates.map(({ name, description }) => ({
      description,
      name,
      source: "prompt",
    }));
    const skills = session.resourceLoader
      .getSkills()
      .skills.map(({ name, description }) => ({
        description,
        name: `skill:${name}`,
        source: "skill",
      }));
    return [...extensions, ...prompts, ...skills];
  }

  async setModel(sessionId, provider, modelId) {
    const session = await this.sessions.get(sessionId);
    const model = (await this.runtime()).getModel(provider, modelId);
    if (!(session && model)) {
      throw new Error("Model is not available");
    }
    await session.setModel(model);
  }

  async setThinking(sessionId, level) {
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Open a session first");
    }
    session.setThinkingLevel(level);
  }

  async prompt({ sessionId, message, cwd, sessionPath, requestId, images }) {
    if (requestId) {
      const existing = this.events.requestResult(requestId);
      if (existing) {
        return existing;
      }
    }
    const session = await this.ensure(sessionId, cwd, sessionPath);
    const result = {
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
    };
    if (requestId) {
      this.events.saveRequest(requestId, result);
    }
    if (images !== undefined && !Array.isArray(images)) {
      throw new Error("Invalid image attachments");
    }
    if (images && images.length > 8) {
      throw new Error("Too many image attachments");
    }
    const validImages = images?.map((image) => {
      if (
        image?.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string" ||
        !image.mimeType.startsWith("image/") ||
        image.data.length > MAX_IMAGE_DATA_LENGTH
      ) {
        throw new Error("Invalid image attachment");
      }
      return image;
    });
    const options = {
      ...(session.isStreaming ? { streamingBehavior: "followUp" } : {}),
      ...(validImages?.length ? { images: validImages } : {}),
    };
    session
      .prompt(message, Object.keys(options).length ? options : undefined)
      .catch((error) =>
        this.events.append(sessionId, {
          message: error instanceof Error ? error.message : String(error),
          type: "omo_error",
        })
      );
    return result;
  }

  async abort(sessionId) {
    await (await this.sessions.get(sessionId))?.abort();
  }

  async providers() {
    const runtime = await this.runtime();
    return Promise.all(
      runtime.getProviders().map(async (provider) => {
        let auth;
        let error;
        try {
          auth = await runtime.checkAuth(provider.id, {
            signal: AbortSignal.timeout(5000),
          });
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        return {
          authType: auth?.type,
          connected: !!auth,
          error,
          hasApiKey: !!provider.auth.apiKey?.login,
          hasOAuth: !!provider.auth.oauth,
          id: provider.id,
          name: provider.name,
          source: auth?.source,
          subscription: !!provider.auth.oauth?.isSubscription,
        };
      })
    );
  }

  async login(providerId, type) {
    const runtime = await this.runtime();
    await runtime.login(providerId, type, {
      notify: (event) =>
        this.events.append("__providers", {
          event,
          kind: "notify",
          providerId,
        }),
      prompt: (prompt) => {
        const requestId = crypto.randomUUID();
        this.events.append("__providers", {
          kind: "prompt",
          prompt: { ...prompt, signal: undefined },
          providerId,
          requestId,
        });
        return new Promise((resolve, reject) =>
          this.authPrompts.set(requestId, { reject, resolve })
        );
      },
    });
    return true;
  }

  respond(requestId, value) {
    const pending = this.authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
    this.authPrompts.delete(requestId);
    pending.resolve(value);
    return true;
  }

  cancel(requestId) {
    const pending = this.authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
    this.authPrompts.delete(requestId);
    pending.reject(new Error("Authentication cancelled"));
    return true;
  }

  async logout(providerId) {
    await (await this.runtime()).logout(providerId);
    return true;
  }
}

module.exports = { PiService };
