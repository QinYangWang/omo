import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
export const EXTENSION_ENTRY = path.join(PACKAGE_ROOT, "index.js");
export const PI_BINARY = path.join(REPO_ROOT, "node_modules", ".bin", "pi");

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function makeCtx({
  cwd = REPO_ROOT,
  idle = true,
  sessionFile = "/tmp/omo-lifecycle-session.jsonl",
  sessionId = "session-lifecycle",
} = {}) {
  return {
    abort: () => undefined,
    cwd,
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };
}

/** Minimal `ExtensionAPI`-shaped double: captures handlers and replays them. */
export function createMockPi() {
  const handlers = new Map();
  const api = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage() {
      // The mock records nothing; command-bridge coverage uses a live Pi.
    },
  };
  return {
    api,
    emit: async (name, event = { type: name }, ctx = makeCtx()) => {
      const list = handlers.get(name) ?? [];
      await Promise.all(list.map((handler) => handler(event, ctx)));
    },
    handlersFor: (name) => handlers.get(name) ?? [],
  };
}

/**
 * Local HTTP receiver covering both the E0 spike body endpoints and the E0-003
 * SSE command stream. Records every JSON body and exposes the live command
 * stream clients so tests can push frames or observe disconnects.
 */
export function startReceiver() {
  const received = [];
  const commandClients = new Set();
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/commands") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(": omo command stream connected\n\n");
      commandClients.add(response);
      request.on("close", () => commandClients.delete(response));
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          // Ignore malformed bodies; assertions surface missing records.
        }
        response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
        commandClients,
        hasCommandClient: () => commandClients.size > 0,
        received,
        sendCommand(command) {
          const frame = `data: ${JSON.stringify(command)}\n\n`;
          for (const client of commandClients) {
            client.write(frame);
          }
          return commandClients.size;
        },
        server,
        url: { commands: `${origin}/commands`, events: `${origin}/events` },
      });
    });
  });
}

export function spawnPi({ args, env = {}, timeoutMs = 120_000 }) {
  const child = spawn(PI_BINARY, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  return {
    child,
    closed,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}

export function waitFor(predicate, { label, timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  const poll = async () => {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(25);
    return poll();
  };
  return poll();
}
