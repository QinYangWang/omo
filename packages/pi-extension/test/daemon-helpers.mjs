import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { ExtensionService } = require(
  path.join(REPO_ROOT, "server", "extension-service.cjs")
);

export function registerRequest(overrides = {}) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0",
    instanceId: crypto.randomUUID(),
    piVersion: "0.85.0",
    sessionId: "session-daemon-test",
    ...overrides,
  };
}

/**
 * Serves the real `ExtensionService` over a real Unix socket and records
 * everything a daemon-side observer can see: raw requests, register /
 * heartbeat / events / detach calls, native events and detachments.
 */
export async function startDaemonHarness(options = {}) {
  const {
    heartbeatIntervalMs = 1000,
    heartbeatTimeoutMs = 15_000,
    now,
    onDetach: userOnDetach,
    onNativeEvent: userOnNativeEvent,
    sweepIntervalMs = 100,
    ...serviceOptions
  } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-pi-ext-daemon-"));
  const socketPath = path.join(root, "extension.sock");
  const nativeEvents = [];
  const detaches = [];
  const service = new ExtensionService({
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    hostId: crypto.randomUUID(),
    now,
    onDetach: (sessionId, attachment, reason) => {
      detaches.push({ attachment, reason, sessionId });
      userOnDetach?.(sessionId, attachment, reason);
    },
    onNativeEvent: (attachment, event) => {
      nativeEvents.push({ attachment, event });
      userOnNativeEvent?.(attachment, event);
    },
    sweepIntervalMs,
    ...serviceOptions,
  });

  const registerCalls = [];
  const heartbeatCalls = [];
  const eventBatches = [];
  const detachCalls = [];
  const record = (name, sink) => {
    const original = service[name].bind(service);
    service[name] = (...args) => {
      sink.push(args[0]);
      return original(...args);
    };
  };
  record("register", registerCalls);
  record("heartbeat", heartbeatCalls);
  record("events", eventBatches);
  record("detach", detachCalls);

  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method, pathname: url.pathname });
    service
      .handle(request, response, url)
      .then((handled) => {
        if (!(handled || response.headersSent)) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500);
          response.end();
        }
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    async close() {
      service.dispose();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { force: true, recursive: true });
    },
    detachCalls,
    detaches,
    eventBatches,
    heartbeatCalls,
    nativeEvents,
    registerCalls,
    requests,
    service,
    socketPath,
  };
}
