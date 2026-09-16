"use strict";

// Test helper: acquires the daemon lease for OMO_TEST_DATA_DIR and reports the
// outcome over the process IPC channel. It is used to exercise concurrent
// acquisition and cross-process live-owner detection deterministically.

const path = require("node:path");
const { acquireDaemonLease, tcpEndpoint } = require(
  path.join(__dirname, "..", "..", "server", "daemon-state.cjs")
);

const dataDir = process.env.OMO_TEST_DATA_DIR;
const holdMs = Number(process.env.OMO_TEST_HOLD_MS || 30_000);

function acquire() {
  try {
    const lease = acquireDaemonLease({
      dataDir,
      endpoint: tcpEndpoint({ host: "127.0.0.1", port: 5199 }),
    });
    process.send?.({ pid: lease.state.pid, type: "acquired" });
    const release = () => {
      lease.release();
      process.exit(0);
    };
    process.on("message", (message) => {
      if (message === "release") {
        release();
      }
    });
    setTimeout(release, holdMs).unref();
  } catch (error) {
    process.send?.({
      code: error.code ?? null,
      message: error.message,
      type: "rejected",
    });
    process.exit(0);
  }
}

if (process.send) {
  process.send({ type: "ready" });
  process.on("message", (message) => {
    if (message === "go") {
      acquire();
    }
  });
} else {
  acquire();
}
