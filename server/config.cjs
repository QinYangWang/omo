"use strict";
const os = require("node:os");
const path = require("node:path");

function split(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
}

const localSocket = process.env.OMO_LOCAL_SOCKET || "";
const transport = String(
  process.env.OMO_TRANSPORT || (localSocket ? "socket" : "tcp")
).toLowerCase();
const dataDir = path.resolve(
  process.env.OMO_DATA_DIR || path.join(os.homedir(), ".omo-server")
);
const workspaceRoots = split(
  process.env.OMO_WORKSPACE_ROOTS || process.cwd()
).map((root) => path.resolve(root));

module.exports = {
  corsOrigins: split(process.env.OMO_CORS_ORIGINS),
  dataDir,
  eventRetention: Number(process.env.OMO_EVENT_RETENTION || 100_000),
  extensionHeartbeatIntervalMs: positiveInteger(
    process.env.OMO_EXTENSION_HEARTBEAT_INTERVAL_MS,
    5000
  ),
  extensionHeartbeatTimeoutMs: positiveInteger(
    process.env.OMO_EXTENSION_HEARTBEAT_TIMEOUT_MS,
    15_000
  ),
  host: process.env.OMO_HOST || "127.0.0.1",
  localSocket,
  port: Number(process.env.OMO_PORT || 5189),
  sessionRoot: path.resolve(
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    "sessions"
  ),
  tlsCert: process.env.OMO_TLS_CERT || "",
  tlsKey: process.env.OMO_TLS_KEY || "",
  token: process.env.OMO_TOKEN || "",
  transport,
  webRoot: path.resolve(
    process.env.OMO_WEB_ROOT || path.join(__dirname, "..", "dist")
  ),
  workspaceRoots,
};
