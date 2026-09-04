"use strict";
/**
 * Real agent skills and pi packages, shared by omo Server and Electron.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const sdkPromise = import("@earendil-works/pi-coding-agent");

async function listSkills(agentDir) {
  const { loadSkillsFromDir } = await sdkPromise;
  const result = loadSkillsFromDir({
    dir: path.join(agentDir, "skills"),
    source: "user",
  });
  return result.skills.map((skill) => ({
    description: skill.description,
    filePath: skill.filePath,
    name: skill.name,
  }));
}

function readSettings(agentDir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")
    );
  } catch {
    return {};
  }
}

function writeSettings(agentDir, settings) {
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`
  );
}

function parseNpmSource(source) {
  if (!source.startsWith("npm:")) {
    return null;
  }
  const spec = source.slice(4);
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  return { name: spec };
}

function packageKind(source) {
  if (source.startsWith("npm:")) {
    return "npm";
  }
  if (source.startsWith("git:")) {
    return "git";
  }
  return "path";
}

function installedNpmVersion(agentDir, name) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(agentDir, "npm", "node_modules", name, "package.json"),
        "utf8"
      )
    ).version;
  } catch {
    // package not installed yet
  }
}

function listPackages(agentDir) {
  const settings = readSettings(agentDir);
  const sources = Array.isArray(settings.packages) ? settings.packages : [];
  return sources
    .filter((source) => typeof source === "string")
    .map((source) => {
      const npm = parseNpmSource(source);
      const installedVersion = npm
        ? installedNpmVersion(agentDir, npm.name)
        : undefined;
      return {
        installedVersion,
        kind: packageKind(source),
        name: npm?.name ?? source,
        source,
        version: npm?.version ?? installedVersion,
      };
    });
}

function npmExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      args,
      { cwd, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function installPackage(agentDir, source) {
  const npm = parseNpmSource(source);
  if (!npm) {
    throw new Error("Only npm: sources are supported (e.g. npm:@scope/pkg)");
  }
  const prefix = path.join(agentDir, "npm");
  fs.mkdirSync(prefix, { recursive: true });
  await npmExec(
    [
      "install",
      "--prefix",
      prefix,
      npm.version ? `${npm.name}@${npm.version}` : npm.name,
    ],
    prefix
  );
  const settings = readSettings(agentDir);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (!packages.includes(source)) {
    settings.packages = [...packages, source];
    writeSettings(agentDir, settings);
  }
  return listPackages(agentDir);
}

function removePackage(agentDir, source) {
  const settings = readSettings(agentDir);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  settings.packages = packages.filter((entry) => entry !== source);
  writeSettings(agentDir, settings);
  return listPackages(agentDir);
}

// ---------- model filtering (pi `enabledModels` setting) ----------

const globChars = /[.+^${}()|[\]\\]/g;

/** minimatch-style glob subset: `*` and `?`, matched against the full string. */
function globToRegExp(pattern) {
  const source = pattern
    .replace(globChars, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

/** enabledModels entries: `provider/modelId` or bare `modelId`, optional `:level`. */
function modelEnabled(settings, model) {
  const patterns = Array.isArray(settings.enabledModels)
    ? settings.enabledModels
    : [];
  if (patterns.length === 0) {
    return true;
  }
  const key = modelKey(model);
  return patterns.some((raw) => {
    if (typeof raw !== "string") {
      return false;
    }
    const [pattern] = raw.split(":");
    const regex = globToRegExp(pattern);
    return regex.test(key) || regex.test(model.id);
  });
}

function listModels(agentDir, available) {
  const settings = readSettings(agentDir);
  return available.map((model) => ({
    ...model,
    enabled: modelEnabled(settings, model),
  }));
}

function setModelsEnabled(agentDir, available, enabledKeys) {
  const settings = readSettings(agentDir);
  const enabled = new Set(
    Array.isArray(enabledKeys) ? enabledKeys.map(String) : []
  );
  const allEnabled = available.every((model) => enabled.has(modelKey(model)));
  if (allEnabled) {
    settings.enabledModels = undefined;
  } else {
    settings.enabledModels = available
      .filter((model) => enabled.has(modelKey(model)))
      .map((model) => modelKey(model));
  }
  writeSettings(agentDir, settings);
  return listModels(agentDir, available);
}

module.exports = {
  installPackage,
  listModels,
  listPackages,
  listSkills,
  removePackage,
  setModelsEnabled,
};
