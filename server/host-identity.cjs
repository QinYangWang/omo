"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HOST_FILE_NAME = "host.json";
const HOST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isHostId(value) {
  return typeof value === "string" && HOST_ID_PATTERN.test(value);
}

function loadHostIdentity(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, HOST_FILE_NAME);
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isHostId(existing.hostId)) {
      return existing.hostId;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Unable to read Host identity: ${error.message}`, {
        cause: error,
      });
    }
  }

  const hostId = crypto.randomUUID();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ hostId, version: 1 }, null, 2)}\n`,
    { mode: 0o600 }
  );
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
  return hostId;
}

module.exports = { loadHostIdentity };
