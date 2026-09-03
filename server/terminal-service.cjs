"use strict";
const pty = require("node-pty");

class TerminalService {
  constructor(workspace, options = {}) {
    this.workspace = workspace;
    this.terminals = new Map();
    this.tickets = new Map();
    this.maxBuffer = options.maxBuffer || 2 * 1024 * 1024;
    this.idleMs = options.idleMs || 30 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000).unref();
  }

  async create(cwd) {
    const targetCwd = await this.workspace.resolveExisting(
      cwd || this.workspace.roots[0]
    );
    const id = crypto.randomUUID();
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const args = process.platform === "win32" ? ["-NoLogo"] : ["--login"];
    const processHandle = pty.spawn(shell, args, {
      cols: 120,
      cwd: targetCwd,
      env: { ...process.env, COLORTERM: "truecolor", TERM: "xterm-256color" },
      name: "xterm-256color",
      rows: 30,
    });
    const terminal = {
      chunks: [],
      exited: false,
      floor: 0,
      id,
      offset: 0,
      process: processHandle,
      sockets: new Set(),
      touchedAt: Date.now(),
    };
    this.terminals.set(id, terminal);
    processHandle.onData((data) => this.write(terminal, data));
    processHandle.onExit(({ exitCode }) => {
      terminal.exited = true;
      this.broadcast(terminal, {
        exitCode,
        offset: terminal.offset,
        type: "exit",
      });
      for (const socket of terminal.sockets) {
        socket.close(1000, "terminal exited");
      }
    });
    return {
      offset: terminal.offset,
      terminalId: id,
      ticket: this.issueTicket(id),
    };
  }

  issueTicket(terminalId) {
    if (!this.terminals.has(terminalId)) {
      throw Object.assign(new Error("Terminal not found"), { statusCode: 404 });
    }
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { expiresAt: Date.now() + 30_000, terminalId });
    return ticket;
  }

  consumeTicket(ticket, terminalId) {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return (
      !!value &&
      value.terminalId === terminalId &&
      value.expiresAt >= Date.now()
    );
  }

  attach(terminalId, socket, after = 0) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      socket.close(1008, "terminal not found");
      return;
    }
    terminal.sockets.add(socket);
    terminal.touchedAt = Date.now();
    let cursor = after;
    if (cursor < terminal.floor) {
      socket.send(JSON.stringify({ offset: terminal.floor, type: "reset" }));
      cursor = terminal.floor;
    }
    for (const chunk of terminal.chunks) {
      if (chunk.end <= cursor) {
        continue;
      }
      const skip = Math.max(0, cursor - chunk.start);
      socket.send(
        JSON.stringify({
          data: chunk.data.slice(skip),
          nextOffset: chunk.end,
          offset: chunk.start + skip,
          type: "output",
        })
      );
    }
    if (terminal.exited) {
      socket.send(JSON.stringify({ offset: terminal.offset, type: "exit" }));
    }
    socket.on("message", (raw) => {
      terminal.touchedAt = Date.now();
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (
        message.type === "input" &&
        typeof message.data === "string" &&
        !terminal.exited
      ) {
        terminal.process.write(message.data);
      }
      if (
        message.type === "resize" &&
        Number.isFinite(message.cols) &&
        Number.isFinite(message.rows) &&
        !terminal.exited
      ) {
        terminal.process.resize(
          Math.max(2, message.cols),
          Math.max(1, message.rows)
        );
      }
    });
    socket.on("close", () => {
      terminal.sockets.delete(socket);
      terminal.touchedAt = Date.now();
    });
  }

  write(terminal, data) {
    const chunk = {
      data,
      end: terminal.offset + data.length,
      start: terminal.offset,
    };
    terminal.offset = chunk.end;
    terminal.touchedAt = Date.now();
    terminal.chunks.push(chunk);
    let size = terminal.offset - terminal.floor;
    while (size > this.maxBuffer && terminal.chunks.length > 1) {
      const removed = terminal.chunks.shift();
      terminal.floor = removed.end;
      size = terminal.offset - terminal.floor;
    }
    this.broadcast(terminal, {
      data,
      nextOffset: chunk.end,
      offset: chunk.start,
      type: "output",
    });
  }

  broadcast(terminal, message) {
    const payload = JSON.stringify(message);
    for (const socket of terminal.sockets) {
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt < now) {
        this.tickets.delete(ticket);
      }
    }
    for (const [id, terminal] of this.terminals) {
      if (
        terminal.sockets.size === 0 &&
        now - terminal.touchedAt > this.idleMs
      ) {
        if (!terminal.exited) {
          terminal.process.kill();
        }
        this.terminals.delete(id);
      }
    }
  }
}

module.exports = { TerminalService };
