const os = require("node:os");
const path = require("node:path");

function split(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const dataDir = path.resolve(process.env.OMO_DATA_DIR || path.join(os.homedir(), ".omo-server"));
const workspaceRoots = split(process.env.OMO_WORKSPACE_ROOTS || process.cwd()).map((root) => path.resolve(root));

module.exports = {
  host: process.env.OMO_HOST || "127.0.0.1",
  port: Number(process.env.OMO_PORT || 5189),
  token: process.env.OMO_TOKEN || "",
  dataDir,
  workspaceRoots,
  webRoot: path.resolve(process.env.OMO_WEB_ROOT || path.join(__dirname, "..", "dist")),
  corsOrigins: split(process.env.OMO_CORS_ORIGINS),
  eventRetention: Number(process.env.OMO_EVENT_RETENTION || 100000),
  sessionRoot: path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions"),
};
