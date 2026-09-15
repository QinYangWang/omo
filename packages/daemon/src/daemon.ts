import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@omo/agent-runtime/runtime";
import { CommandInbox } from "@omo/control-plane/inbox";
import { InteractionStore } from "@omo/control-plane/interactions";
import {
  type DurabilityReport,
  readDurabilityReport,
} from "@omo/storage/durability";
import { openDurableDatabase } from "@omo/storage/durable-database";
import { ArtifactStore } from "./artifacts.ts";
import { DraftStore } from "./drafts.ts";
import { DaemonEventBus } from "./events.ts";
import {
  type DaemonIdentity,
  DaemonIdentityStore,
  DaemonLock,
  DeviceStore,
  loadPairingCode,
} from "./identity.ts";
import { CommandService } from "./service.ts";
import { SessionSupervisor } from "./supervisor.ts";
import { NdjsonTelemetry } from "./telemetry.ts";
import { type PtySpawner, TerminalManager } from "./terminal.ts";
import { SessionCatalog, WorkspaceRegistry } from "./workspaces.ts";

/** Lazy node-pty load: the native module resolves on first terminal.create. */
const nodePtySpawner = (): PtySpawner => {
  let spawner: PtySpawner | undefined;
  return (options) => {
    if (!spawner) {
      const require = createRequire(import.meta.url);
      const pty = require("node-pty") as typeof import("node-pty");
      spawner = ({ cols, cwd, rows, shell }) => {
        let args: string[] = [];
        if (process.platform === "win32") {
          args = ["-NoLogo"];
        } else if (shell.endsWith("bash") || shell.endsWith("zsh")) {
          args = ["--login"];
        }
        const child = pty.spawn(shell, args, {
          cols,
          cwd,
          env: {
            ...process.env,
            COLORTERM: "truecolor",
            LANG: process.env.LANG || "en_US.UTF-8",
            TERM: "xterm-256color",
            TERM_PROGRAM: "omo",
          },
          name: "xterm-256color",
          rows,
        });
        return child;
      };
    }
    return spawner(options);
  };
};

/**
 * The modular omo daemon control plane (plan §4.1, §13 P1; ADR-001).
 *
 * Data directory layout (all SQLite connections WAL + synchronous=FULL):
 *
 *   <dataDir>/daemon.lock     single-writer ownership (§5.5)
 *   <dataDir>/control.sqlite  commands + interactions + devices + workspaces
 *                             + session catalog + ownership + artifact
 *                             metadata + daemon meta — ONE commit domain, so
 *                             a crash can never split the receipt from the
 *                             execution bookkeeping (§5.4)
 *   <dataDir>/sessions/       per-session execution databases owned by the
 *                             runtime (upstream SqliteSessionRepo layout)
 *   <dataDir>/artifacts/      content-addressed objects + tmp staging; the
 *                             metadata row commits only after the object is
 *                             durably renamed (§5.8.3)
 *   <dataDir>/pairing-code    bootstrap code, mode 0600 (only when no
 *                             explicit code / env var was provided)
 *
 * P1 keeps Session Workers in-process; moving them to separate OS processes
 * (ADR-006) must reuse this same ownership + epoch contract.
 */

export interface OpenDaemonOptions {
  /** Bound on draining in-flight execution during close (testing crashes). */
  readonly closeGraceMs?: number;
  readonly dataDir: string;
  readonly maxWorkers?: number;
  /** Bootstrap pairing code; falls back to env var, then a 0600 file. */
  readonly pairingCode?: string;
  /** PTY spawner override for tests; defaults to node-pty (lazy-loaded). */
  readonly ptySpawner?: PtySpawner;
  readonly retryDelayMs?: number;
  readonly runtime: AgentRuntime;
  /** Set false to disable the local NDJSON telemetry sink (default on). */
  readonly telemetry?: boolean;
  /**
   * Directories under which workspaces may be registered (§10.2). Defaults
   * to OMO_WORKSPACE_ROOTS (comma-separated) and then the process cwd — the
   * same convention as v1 `server/config.cjs`.
   */
  readonly workspaceRoots?: readonly string[];
}

export interface Daemon {
  readonly artifacts: ArtifactStore;
  readonly catalog: SessionCatalog;
  readonly close: () => Promise<void>;
  /** Live devices by id — maintained by the sync hub (§6.6 控制权转交). */
  readonly connectedDevices: Set<string>;
  readonly controlDatabase: DatabaseSync;
  readonly devices: DeviceStore;
  readonly drafts: DraftStore;
  readonly durability: DurabilityReport;
  readonly events: DaemonEventBus;
  readonly identity: DaemonIdentity;
  readonly pairingCode: string;
  readonly runtime: AgentRuntime;
  readonly service: CommandService;
  readonly supervisor: SessionSupervisor;
  readonly telemetry: NdjsonTelemetry;
  readonly terminals: TerminalManager;
  readonly workspaces: WorkspaceRegistry;
}

const defaultWorkspaceRoots = (): readonly string[] => {
  const fromEnv = process.env.OMO_WORKSPACE_ROOTS;
  if (fromEnv) {
    const roots = fromEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (roots.length > 0) {
      return roots;
    }
  }
  return [process.cwd()];
};

export const openDaemon = (options: OpenDaemonOptions): Daemon => {
  mkdirSync(options.dataDir, { recursive: true });
  const lock = DaemonLock.acquire(options.dataDir);
  let db: DatabaseSync | undefined;
  try {
    const { db: controlDb } = openDurableDatabase(
      join(options.dataDir, "control.sqlite")
    );
    db = controlDb;
    const bus = new DaemonEventBus();
    const identityStore = DaemonIdentityStore.attach(db);
    const identity = identityStore.identity();
    const devices = DeviceStore.attach(db, identity);
    const inbox = CommandInbox.attach(db, (command) =>
      bus.emit({ command, type: "command" })
    );
    const interactions = InteractionStore.attach(db, (interaction) =>
      bus.emit({ interaction, type: "interaction" })
    );
    const workspaces = WorkspaceRegistry.attach(
      db,
      options.workspaceRoots ?? defaultWorkspaceRoots(),
      (workspace) => bus.emit({ type: "workspace", workspace })
    );
    const catalog = SessionCatalog.attach(db, (session) =>
      bus.emit({ session, type: "session" })
    );
    const drafts = DraftStore.attach(db, (draft) =>
      bus.emit({ draft, type: "draft" })
    );
    const artifacts = ArtifactStore.open(options.dataDir, db);
    // The lock guarantees we are the only writer, so sweeping crash-orphaned
    // objects at startup cannot race a live publish (§5.8.3).
    artifacts.sweepOrphans();
    const telemetry = new NdjsonTelemetry({
      filePath: join(options.dataDir, "telemetry.ndjson"),
    });
    const supervisor = new SessionSupervisor({
      closeGraceMs: options.closeGraceMs,
      db,
      instanceToken: lock.token,
      maxWorkers: options.maxWorkers,
      onLaneEvent: (sessionId, event, snapshot) =>
        bus.emit({ event, sessionId, snapshot, type: "lane" }),
      runtime: options.runtime,
    });
    const connectedDevices = new Set<string>();
    const terminals = new TerminalManager({
      db,
      isDeviceConnected: (deviceId) => connectedDevices.has(deviceId),
      onEvent: (event) => bus.emit(event),
      spawner: options.ptySpawner ?? nodePtySpawner(),
    });
    const service = new CommandService({
      artifacts,
      catalog,
      drafts,
      inbox,
      interactions,
      retryDelayMs: options.retryDelayMs,
      runtime: options.runtime,
      supervisor,
      telemetry: options.telemetry === false ? undefined : telemetry,
      terminals,
      workspaces,
    });
    const pairingCode = loadPairingCode(options.dataDir, options.pairingCode);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await service.close(options.closeGraceMs);
      await supervisor.closeAll();
      terminals.closeAll();
      await options.runtime.close();
      db?.close();
      lock.release();
    };

    // Startup recovery AFTER all stores are attached (§5.5 recovery order).
    service.reconcile();

    return {
      artifacts,
      catalog,
      close,
      connectedDevices,
      controlDatabase: db,
      devices,
      drafts,
      durability: readDurabilityReport(db),
      events: bus,
      identity,
      pairingCode,
      runtime: options.runtime,
      service,
      supervisor,
      telemetry,
      terminals,
      workspaces,
    };
  } catch (error) {
    db?.close();
    lock.release();
    throw error;
  }
};
