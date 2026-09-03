"use strict";
const os = require("node:os");
const path = require("node:path");

function split(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  host: process.env.OMO_HOST || "127.0.0.1",
  port: Number(process.env.OMO_PORT || 5189),
  sessionRoot: path.resolve(
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    "sessions"
  ),
  token: process.env.OMO_TOKEN || "",
  webRoot: path.resolve(
    process.env.OMO_WEB_ROOT || path.join(__dirname, "..", "dist")
  ),
  workspaceRoots,
};
