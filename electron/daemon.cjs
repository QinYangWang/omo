"use strict";

/**
 * Electron main-process supervisor for the omo daemon (plan §4.2, §12.2
 * step 2): the desktop shell OWNS the daemon lifecycle — spawn on launch,
 * health-gate on /v1/hello, pair once and keep the device token in
 * safeStorage-backed storage, restart with bounded backoff on crash, stop
 * cleanly on quit (the daemon's own §5.5 recovery covers the rest).
 *
 * Everything OS/Electron-specific is injectable so this file is testable in
 * plain Node (test/daemon-supervisor.test.mjs).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_OPTS = {
  maxRestarts: 3,
  readyPollMs: 100,
  readyTimeoutMs: 20_000,
  stopGraceMs: 3000,
};

/** Probe a free loopback port (small race is acceptable for local desktop). */
const probePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

class DaemonSupervisor {
  #child;
  #config;
  #lastError;
  #ready = null; // resolves when the daemon answers /v1/hello
  #restartCount = 0;
  #state = "stopped"; // stopped | starting | ready | failed
  #stateListeners = new Set();
  #stopping = false;

  /**
   * @param {object} options
   * @param {string} options.dataDir       daemon data dir (userData/omo-daemon)
   * @param {string} options.daemonScript  packages/daemon/bin/omo-daemon.ts
   * @param {string[]} options.workspaceRoots
   * @param {string[]} options.providerArgs e.g. ["--faux"] or ["--provider", id, "--model", id]
   * @param {{read(): string | null, write(token: string): void, clear(): void}} options.tokenStorage
   * @param {typeof spawn} [options.spawnImpl]   test injection
   * @param {typeof fetch} [options.fetchImpl]   test injection
   * @param {(line: string) => void} [options.log]
   */
  constructor(options) {
    this.opts = { fetchImpl: fetch, ...DEFAULT_OPTS, ...options };
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
  }

  get state() {
    return this.#state;
  }

  get lastError() {
    return this.#lastError;
  }

  /** PID of the supervised daemon process (diagnostics and tests). */
  get childPid() {
    return this.#child?.pid ?? null;
  }

  onStateChange(listener) {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  #setState(next, error) {
    this.#state = next;
    this.#lastError = error ?? null;
    for (const listener of this.#stateListeners) {
      try {
        listener(next, this.#lastError);
      } catch {
        // ignore listener failures
      }
    }
  }

  /** The renderer-facing connection config; null until ready. */
  config() {
    return this.#config ?? null;
  }

  start() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: reset on crash/restart
    if (this.#ready) {
      return this.#ready;
    }
    this.#ready = this.#spawnAndReady().catch((error) => {
      this.#setState("failed", error);
      throw error;
    });
    return this.#ready;
  }

  async #spawnAndReady() {
    this.#setState("starting");
    const port = await probePort();
    const pairingCode = crypto.randomBytes(6).toString("hex");
    const args = [
      this.opts.daemonScript,
      "--data-dir",
      this.opts.dataDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--pairing-code",
      pairingCode,
      ...this.opts.providerArgs,
    ];
    for (const root of this.opts.workspaceRoots) {
      args.push("--workspace-root", root);
    }
    const spawnImpl = this.opts.spawnImpl ?? spawn;
    const child = spawnImpl(process.execPath, args, {
      env: {
        ...process.env,
        // Run inside Electron's embedded Node, not a new Electron window.
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    const log = this.opts.log ?? (() => undefined);
    child.stdout?.on("data", (chunk) =>
      log(`[daemon] ${String(chunk).trim()}`)
    );
    child.stderr?.on("data", (chunk) =>
      log(`[daemon:err] ${String(chunk).trim()}`)
    );
    child.on("exit", (code, signal) => {
      this.#child = undefined;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by stop()
      if (this.#stopping) {
        return;
      }
      this.#config = undefined;
      this.#ready = null;
      this.#setState("failed", new Error(`daemon exited (${code ?? signal})`));
      this.#maybeRestart().catch(() => undefined);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await this.#waitReady(baseUrl);

    // Pair once per device; the token survives daemon restarts (control DB).
    let token = this.opts.tokenStorage.read();
    if (!token) {
      const pairing = await this.opts.fetchImpl(`${baseUrl}/v1/pairing`, {
        body: JSON.stringify({ code: pairingCode, name: "omo desktop" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!pairing.ok) {
        throw new Error(`daemon pairing failed: HTTP ${pairing.status}`);
      }
      const { token: pairedToken } = await pairing.json();
      token = pairedToken;
      this.opts.tokenStorage.write(token);
    }
    const hello = await (
      await this.opts.fetchImpl(`${baseUrl}/v1/hello`)
    ).json();
    this.#config = {
      baseUrl,
      serverId: hello.identity.serverId,
      token,
      wsUrl: `ws://127.0.0.1:${port}/v1/sync`,
    };
    this.#restartCount = 0;
    this.#setState("ready");
    return this.#config;
  }

  async #waitReady(baseUrl) {
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    for (;;) {
      const running = this.#child;
      if (!running) {
        throw new Error("daemon exited before becoming ready");
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: readiness is polled deliberately
        const response = await this.opts.fetchImpl(`${baseUrl}/v1/hello`);
        if (response.ok) {
          return;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        throw new Error("daemon did not become ready in time");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.opts.readyPollMs)
      );
    }
  }

  async #maybeRestart() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by stop()
    if (this.#stopping || this.#restartCount >= this.opts.maxRestarts) {
      return;
    }
    this.#restartCount += 1;
    await new Promise((resolve) =>
      setTimeout(resolve, 500 * this.#restartCount)
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by stop()
    if (this.#stopping) {
      return;
    }
    try {
      await this.start();
    } catch {
      // state already recorded by start()
    }
  }

  async stop() {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) {
      return;
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve("timeout"), this.opts.stopGraceMs)
    );
    const outcome = await Promise.race([exited, timeout]);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
    this.#setState("stopped");
  }
}

/** Pairing-token storage backed by Electron safeStorage (at rest). */
const createSafeStorageTokenStore = (safeStorage, dataDir) => {
  const file = path.join(dataDir, "device-token.enc");
  return {
    clear() {
      fs.rmSync(file, { force: true });
    },
    read() {
      try {
        const raw = fs.readFileSync(file, "utf8");
        if (!(raw && safeStorage.isEncryptionAvailable())) {
          return null;
        }
        return safeStorage.decryptString(Buffer.from(raw, "base64"));
      } catch {
        return null;
      }
    },
    write(token) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("safeStorage is unavailable");
      }
      fs.writeFileSync(
        file,
        safeStorage.encryptString(token).toString("base64"),
        { mode: 0o600 }
      );
    },
  };
};

module.exports = { createSafeStorageTokenStore, DaemonSupervisor };
