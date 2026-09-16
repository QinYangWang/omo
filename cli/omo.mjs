#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { HttpHostClient } from "@omo/client-core";
import { createLocalEndpointFetch } from "./local-transport.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ENTRY = fileURLToPath(
  new URL("../server/index.cjs", import.meta.url)
);
const DEFAULT_URL = "http://127.0.0.1:5189";
const START_TIMEOUT_MS = 8000;
const RETRY_MS = 100;
const SESSION_TITLE_WHITESPACE = /\s+/g;
const TRAILING_SLASH = /\/$/;
const VALUE_OPTIONS = new Map([
  ["--cwd", "cwd"],
  ["--data-dir", "dataDir"],
  ["--host", "host"],
  ["--port", "port"],
  ["--session", "sessionPath"],
  ["--socket", "socket"],
  ["--token", "token"],
  ["--url", "url"],
]);

const colors = {
  accent: (value) => `\u001b[36m${value}\u001b[39m`,
  dim: (value) => `\u001b[2m${value}\u001b[22m`,
  error: (value) => `\u001b[31m${value}\u001b[39m`,
  success: (value) => `\u001b[32m${value}\u001b[39m`,
  warning: (value) => `\u001b[33m${value}\u001b[39m`,
};

const editorTheme = {
  borderColor: colors.accent,
  selectList: {
    description: colors.dim,
    noMatch: colors.warning,
    scrollInfo: colors.dim,
    selectedPrefix: colors.accent,
    selectedText: colors.accent,
  },
};

function parseArguments(argv) {
  const options = {
    command: "tui",
    cwd: process.cwd(),
    dataDir: process.env.OMO_DATA_DIR,
    host: process.env.OMO_HOST || "127.0.0.1",
    port: process.env.OMO_PORT || "5189",
    sessionPath: undefined,
    socket: process.env.OMO_LOCAL_SOCKET || "",
    token: process.env.OMO_TOKEN || "",
    url: process.env.OMO_URL || DEFAULT_URL,
  };
  const positional = [];
  let pendingOption;
  for (const argument of argv) {
    if (pendingOption) {
      options[pendingOption] = argument;
      pendingOption = undefined;
      continue;
    }
    const option = VALUE_OPTIONS.get(argument);
    if (option) {
      pendingOption = option;
    } else if (argument !== "--") {
      positional.push(argument);
    }
  }
  if (pendingOption) {
    throw new Error(`Missing value for --${pendingOption}`);
  }
  options.url = options.url.replace(TRAILING_SLASH, "");
  if (positional[0] === "serve") {
    options.command = "serve";
  } else if (positional[0] === "session" && positional[1] === "list") {
    options.command = "session-list";
  } else if (positional[0] === "session" && positional[1] === "new") {
    options.command = "session-new";
  }
  return options;
}

async function waitForHost(client, baseUrl) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Host startup must be polled sequentially.
      return await client.health();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw new Error(`Timed out waiting for omo Host at ${baseUrl}`);
}

async function ensureLocalHost(client, target, allowAutoStart) {
  try {
    return await client.health();
  } catch (error) {
    if (!allowAutoStart) {
      throw new Error(`Unable to connect to omo Host at ${target}`, {
        cause: error,
      });
    }
  }
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PACKAGE_ROOT,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return waitForHost(client, target);
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function initialEntries(messages) {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const role = String(message.role || "assistant");
    const text = textFromContent(
      message.content ?? message.text ?? message.output
    );
    return text ? [{ role, text }] : [];
  });
}

class OmoTui {
  constructor(client, baseUrl, host, options, opened, clientSessionId) {
    this.client = client;
    this.baseUrl = baseUrl;
    this.host = host;
    this.options = options;
    this.clientSessionId = clientSessionId;
    this.sessionPath = opened.sessionFile || options.sessionPath;
    this.entries = initialEntries(opened.messages || []);
    this.eventSequence = opened.eventSequence || 0;
    this.streaming = Boolean(opened.isStreaming);
    this.connectionState = "online";
    this.terminal = new ProcessTerminal();
    this.tui = new TuiMainScreen(this.terminal);
    this.root = new Container();
    this.header = new Text("", 1, 0);
    this.transcript = new Text("", 1, 1);
    this.status = new Text("", 1, 0);
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.root.addChild(this.header);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.transcript);
    this.root.addChild(this.status);
    this.root.addChild(this.editor);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.editor.onSubmit = (text) => {
      this.prompt(text).catch((error) => this.showError(error));
    };
    this.removeInputListener = this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        if (this.streaming) {
          this.abort().catch((error) => this.showError(error));
        } else {
          this.close();
        }
        return { consume: true };
      }
      if (
        matchesKey(data, Key.ctrl("d")) &&
        this.editor.getText().length === 0
      ) {
        this.close();
        return { consume: true };
      }
    });
    this.refresh();
  }

  refresh() {
    const model = this.options.model || "default model";
    this.header.setText(
      `${colors.accent("omo")}  ${this.host.hostId || "legacy-host"}\n${colors.dim(`${this.baseUrl} · ${this.options.cwd} · ${model}`)}`
    );
    const transcript = this.entries
      .map(({ role, text }) => {
        if (role === "user") {
          return `${colors.accent("you")}\n${text}`;
        }
        if (role === "error") {
          return `${colors.error("error")}\n${text}`;
        }
        if (role === "tool") {
          return `${colors.warning("tool")} ${text}`;
        }
        return `${colors.success("assistant")}\n${text}`;
      })
      .join("\n\n");
    this.transcript.setText(transcript || colors.dim("New Session"));
    const activity = this.streaming
      ? colors.warning("Working…  Ctrl+C abort")
      : colors.dim("Enter send · Ctrl+D exit · Ctrl+C exit");
    const connection =
      this.connectionState === "online"
        ? colors.success("● online")
        : colors.warning(`● ${this.connectionState}`);
    this.status.setText(`${connection}  ${activity}`);
    this.editor.disableSubmit = this.streaming;
    this.tui.requestRender();
  }

  consume(record) {
    this.eventSequence = Math.max(this.eventSequence, record.sequence || 0);
    const event = record.payload || {};
    switch (event.type) {
      case "message_start":
        this.consumeMessageStart(event);
        break;
      case "message_update":
        this.consumeMessageUpdate(event);
        break;
      case "tool_execution_start":
        this.entries.push({
          role: "tool",
          text: `${event.toolName || "tool"} …`,
        });
        break;
      case "tool_execution_end":
        this.consumeToolEnd(event);
        break;
      case "agent_end":
        this.streaming = false;
        break;
      case "omo_error":
        this.showError(new Error(event.message || "Unknown error"));
        return;
      default:
        break;
    }
    this.refresh();
  }

  consumeMessageStart(event) {
    if (event.message?.role !== "user") {
      return;
    }
    const text = textFromContent(event.message.content);
    if (text) {
      this.entries.push({ role: "user", text });
    }
    this.streaming = true;
  }

  consumeMessageUpdate(event) {
    const update = event.assistantMessageEvent || {};
    if (update.type !== "text_delta" || !update.delta) {
      return;
    }
    const last = this.entries.at(-1);
    if (last?.role === "assistant") {
      last.text += update.delta;
    } else {
      this.entries.push({ role: "assistant", text: update.delta });
    }
  }

  consumeToolEnd(event) {
    const last = this.entries.at(-1);
    if (last?.role === "tool") {
      last.text = `${event.toolName || "tool"} ${event.isError ? "failed" : "done"}`;
    }
  }

  showError(error) {
    this.entries.push({ role: "error", text: error.message });
    this.streaming = false;
    this.refresh();
  }

  async prompt(message) {
    const text = message.trim();
    if (!text || this.streaming) {
      return;
    }
    this.editor.addToHistory(text);
    this.editor.setText("");
    this.streaming = true;
    this.refresh();
    try {
      const result = await this.client.prompt({
        cwd: this.options.cwd,
        message: text,
        requestId: randomUUID(),
        sessionId: this.clientSessionId,
        sessionPath: this.sessionPath,
      });
      this.sessionPath = result.sessionFile || this.sessionPath;
    } catch (error) {
      this.entries.push({ role: "error", text: error.message });
      this.streaming = false;
      this.refresh();
    }
  }

  async abort() {
    try {
      await this.client.abort({ sessionId: this.clientSessionId });
    } catch (error) {
      this.entries.push({ role: "error", text: error.message });
    }
    this.streaming = false;
    this.refresh();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.subscription?.close();
    this.removeInputListener();
    this.tui.stop();
    this.resolve?.();
  }

  run() {
    this.subscription = this.client.subscribeSession(
      this.clientSessionId,
      this.eventSequence,
      (record) => this.consume(record)
    );
    this.tui.start();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

async function runTui(client, baseUrl, host, options) {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("omo TUI requires an interactive terminal");
  }
  const sessions = await client.listSessions(options.cwd);
  let selectedSession;
  if (options.command !== "session-new") {
    selectedSession = options.sessionPath
      ? sessions.find(
          (session) =>
            session.path === options.sessionPath ||
            session.id === options.sessionPath
        )
      : sessions[0];
  }
  if (options.sessionPath && !selectedSession) {
    throw new Error(`Session not found: ${options.sessionPath}`);
  }
  const sessionPath = selectedSession?.path;
  const clientSessionId = selectedSession?.id || randomUUID();
  const opened = await client.openSession({
    cwd: options.cwd,
    sessionId: clientSessionId,
    sessionPath,
  });
  options.model = opened.model
    ? `${opened.model.provider}/${opened.model.id}`
    : undefined;
  const app = new OmoTui(
    client,
    baseUrl,
    host,
    options,
    opened,
    clientSessionId
  );
  await app.run();
}

/**
 * Starts the local Host in-process while holding the exclusive daemon lease
 * for the resolved data directory. A second concurrent `omo serve` for the
 * same directory is rejected before any listener is created.
 */
async function serveHost(options) {
  process.env.OMO_HOST = options.host;
  process.env.OMO_PORT = options.port;
  if (options.dataDir) {
    process.env.OMO_DATA_DIR = options.dataDir;
  }
  if (options.socket) {
    process.env.OMO_LOCAL_SOCKET = options.socket;
    process.env.OMO_TRANSPORT = "socket";
  }
  if (options.token) {
    process.env.OMO_TOKEN = options.token;
  }
  const config = require("../server/config.cjs");
  const {
    acquireDaemonLease,
    tcpEndpoint,
  } = require("../server/daemon-state.cjs");
  const { startHost } = require("../server/host.cjs");
  const lease = acquireDaemonLease({
    dataDir: config.dataDir,
    endpoint: options.socket
      ? {
          path: options.socket,
          transport: process.platform === "win32" ? "pipe" : "unix",
          url: "http://localhost",
        }
      : tcpEndpoint({
          host: config.host,
          port: config.port,
          tls: Boolean(config.tlsCert),
        }),
  });
  // Normal shutdown removes owned runtime state. SIGKILL skips this handler;
  // the next startup reclaims the stale state instead.
  process.once("exit", () => {
    try {
      lease.release();
    } catch {
      // Best effort: stale state is recovered by the next acquisition.
    }
  });
  let running;
  try {
    running = await startHost();
  } catch (error) {
    lease.release();
    throw error;
  }
  try {
    lease.update({
      endpoint: running.endpoint
        ? {
            path: running.endpoint.path,
            transport: running.endpoint.kind === "pipe" ? "pipe" : "unix",
            url: "http://localhost",
          }
        : tcpEndpoint({
            host: config.host,
            port: running.port,
            tls: Boolean(config.tlsCert),
          }),
      hostId: running.hostId,
    });
  } catch (error) {
    // The lock stays held even if discovery metadata cannot be refreshed.
    console.error(
      `omo: unable to persist daemon discovery state: ${error.message}`
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "serve") {
    await serveHost(options);
    return;
  }

  const useLocalSocket = options.socket.length > 0;
  const client = new HttpHostClient({
    baseUrl: useLocalSocket ? "http://localhost" : options.url,
    fetch: useLocalSocket
      ? createLocalEndpointFetch(options.socket)
      : undefined,
    token: options.token,
  });
  const target = useLocalSocket ? options.socket : options.url;
  // Local sockets are explicit in D1-003; discovery and auto-start of the
  // default daemon endpoint belong to D1-004.
  const canAutoStart = !useLocalSocket && target === DEFAULT_URL;
  const host = await ensureLocalHost(client, target, canAutoStart);
  if (options.command === "session-list") {
    const sessions = await client.listSessions(options.cwd);
    for (const session of sessions) {
      const title = String(session.name || session.firstMessage || "Untitled")
        .replace(SESSION_TITLE_WHITESPACE, " ")
        .slice(0, 100);
      console.log(`${session.id}\t${title}\t${session.path}`);
    }
    return;
  }
  await runTui(client, target, host, options);
}

main().catch((error) => {
  console.error(colors.error(`omo: ${error.message}`));
  process.exitCode = 1;
});
