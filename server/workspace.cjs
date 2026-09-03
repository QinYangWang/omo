"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function requiredPath(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw Object.assign(new Error("Path is required"), { statusCode: 400 });
  }
  return input;
}

function createWorkspaceGuard(roots) {
  const normalizedRoots = roots.map((root) => path.resolve(root));

  async function resolveExisting(input) {
    const target = await fs.realpath(path.resolve(requiredPath(input)));
    const allowedRoots = await Promise.all(
      normalizedRoots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch {
          return root;
        }
      })
    );
    if (!allowedRoots.some((root) => inside(root, target))) {
      const error = new Error("Path is outside configured workspace roots");
      error.statusCode = 403;
      throw error;
    }
    return target;
  }

  async function resolveForWrite(input) {
    const absolute = path.resolve(requiredPath(input));
    const parent = await resolveExisting(path.dirname(absolute));
    const target = path.join(parent, path.basename(absolute));
    if (!normalizedRoots.some((root) => inside(root, target))) {
      const error = new Error("Path is outside configured workspace roots");
      error.statusCode = 403;
      throw error;
    }
    return target;
  }

  return { resolveExisting, resolveForWrite, roots: normalizedRoots };
}

module.exports = { createWorkspaceGuard, inside };
