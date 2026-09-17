#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
import {
  resolveDataDir,
  runHostCommand,
  selectedRegistryHostIsRemote,
} from "./host-registry.mjs";
import {
  buildClientForEndpoint,
  connectRegistryHost,
  connectSelectedRegistryHost,
  endpointLabel,
  ensureExplicitHost,
  ensureLocalHost,
  parseArguments,
  selectTransportMode,
} from "./local-host.mjs";
import {
  assertExtensionExists,
  buildNativeSpawnConfig,
  defaultExtensionPath,
  resolveDaemonSocket,
  resolvePiBinary,
} from "./native-pi.mjs";
import { NATIVE_LOCAL_ONLY_ERROR, selectUiMode, UI_MODE } from "./ui-mode.mjs";

const require = createRequire(import.meta.url);
const SESSION_TITLE_WHITESPACE = /\s+/g;

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

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const HELP_FLAGS = new Set(["--help", "-h"]);

const USAGE = `omo — Pi-native TUI with the omo extension

Usage:
  omo [--native | --legacy-tui] [--cwd <dir>] [--session <path>] [Pi args...]
  omo --server <entryId> | --url <url> | --socket <path>
  omo session list | omo session new
  omo host <list|add|remove|use>
  omo serve [--socket <path>]

UI mode:
  (default local)  discover or start the local omo daemon, then launch the
                   project-locked Pi native TUI with the omo extension
  --native         force the native Pi TUI (local daemon only)
  --legacy-tui     use the legacy omo TUI against the local daemon
  --server, --url, --socket and their environment equivalents always use the
  legacy omo TUI

Environment:
  OMO_DATA_DIR      daemon data directory
  OMO_LOCAL_SOCKET  explicit local daemon socket
  OMO_URL           explicit remote Host URL
  OMO_TOKEN         daemon Bearer token (never passed to Pi)
  OMO_TUI           local UI mode: "native" (default) or "legacy"

Run \`omo --native --help\` to forward --help to the Pi CLI.`;

function printUsage() {
  console.log(USAGE);
}

/**
 * Runs the native Pi TUI as the foreground process sharing the user's TTY.
 * SIGINT/SIGTERM are forwarded so `omo` never leaves an orphaned Pi behind
 * when it is signalled directly instead of through the terminal group.
 */
function runForeground({ command, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // The child exited between the liveness check and the signal.
        }
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      reject(
        new Error(`Unable to start the native Pi TUI: ${error.message}`, {
          cause: error,
        })
      );
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : (code ?? 0));
    });
  });
}

/**
 * Local (default and `--native`) flow: discover/start the local daemon, then
 * hand the terminal to the project-locked Pi CLI with the omo extension
 * explicitly loaded and the daemon socket injected. The daemon is a separate
 * detached process, so Pi exiting does not stop it.
 */
async function runNativePi(options) {
  if (selectTransportMode(options) !== "local") {
    throw new Error(NATIVE_LOCAL_ONLY_ERROR);
  }
  const { endpoint } = await ensureLocalHost(options);
  const daemonSocket = resolveDaemonSocket(endpoint);
  const { binaryPath, version } = resolvePiBinary();
  const extensionPath = assertExtensionExists(defaultExtensionPath());
  const spawnConfig = buildNativeSpawnConfig({
    baseEnv: process.env,
    binaryPath,
    cwd: options.cwd,
    daemonSocket,
    extensionPath,
    passthroughArgs: options.positional,
    piVersion: version,
  });
  console.error(
    `omo: launching project-locked Pi ${version} (${binaryPath}) with extension ${extensionPath} against daemon socket ${daemonSocket}`
  );
  process.exitCode = await runForeground(spawnConfig);
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
  const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");
  const { startHost } = require("../server/host.cjs");
  // Record the endpoint the Host will actually bind before it starts, so a
  // discovery reader never sees a TCP endpoint for a socket transport.
  const localEndpoint =
    config.transport === "socket"
      ? resolveLocalEndpoint({
          dataDir: config.dataDir,
          explicit: config.localSocket,
        })
      : null;
  const lease = acquireDaemonLease({
    dataDir: config.dataDir,
    endpoint: localEndpoint
      ? {
          path: localEndpoint.path,
          transport: localEndpoint.kind === "pipe" ? "pipe" : "unix",
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

/**
 * Resolves the Host client, display target and health record for the active
 * transport mode. Precedence: explicit --socket, explicit --url, their env
 * equivalents, explicit --server, then the selected registry entry, then
 * default local discovery/auto-start. Only local modes ever start a Host, and
 * a selected remote failure never falls back to local.
 */
async function resolveClientTarget(options) {
  const mode = selectTransportMode(options);
  if (mode === "socket") {
    const client = buildClientForEndpoint(
      {
        path: options.socket,
        transport: process.platform === "win32" ? "pipe" : "unix",
      },
      options.token
    );
    return {
      client,
      host: await ensureExplicitHost(client, options.socket),
      target: options.socket,
    };
  }
  if (mode === "url") {
    const client = buildClientForEndpoint(
      { transport: "tcp", url: options.url },
      options.token
    );
    return {
      client,
      host: await ensureExplicitHost(client, options.url),
      target: options.url,
    };
  }
  if (mode === "server" && options.server !== "local") {
    const { client, hostId, label } = await connectRegistryHost(
      options.server,
      options
    );
    return { client, host: { hostId }, target: label };
  }
  const selected =
    mode === "server" ? null : await connectSelectedRegistryHost(options);
  if (selected) {
    const { client, hostId, label } = selected;
    return { client, host: { hostId }, target: label };
  }
  const { client, endpoint, hostId } = await ensureLocalHost(options);
  return { client, host: { hostId }, target: endpointLabel(endpoint) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (
    !options.native &&
    options.positional.some((arg) => HELP_FLAGS.has(arg))
  ) {
    printUsage();
    return;
  }
  if (options.command === "serve") {
    await serveHost(options);
    return;
  }
  if (options.command.startsWith("host-")) {
    if (options.command === "host-usage") {
      throw new Error("Usage: omo host <list|add|remove|use>");
    }
    // Registry metadata commands never discover, start or connect to a Host.
    runHostCommand(options.command, options, resolveDataDir(options));
    return;
  }
  // Explicit commands (`session list`, `session new`, `serve`, `host ...`)
  // keep their legacy behavior; only the default local TUI and an explicit
  // `--native` switch to the native Pi TUI. UI mode selection only runs for
  // the TUI path so a bad OMO_TUI value cannot break `session list`.
  if (options.native || options.command === "tui") {
    const uiMode = selectUiMode(options, process.env, {
      selectedRegistryHostIsRemote: () => selectedRegistryHostIsRemote(options),
    });
    if (uiMode === UI_MODE.native) {
      await runNativePi(options);
      return;
    }
  }

  const { client, target, host } = await resolveClientTarget(options);
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
