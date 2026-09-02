const fs = require("node:fs/promises");
const path = require("node:path");

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createWorkspaceGuard(roots) {
  const normalizedRoots = roots.map((root) => path.resolve(root));

  async function resolveExisting(input) {
    const target = await fs.realpath(path.resolve(input));
    const allowedRoots = await Promise.all(normalizedRoots.map(async (root) => {
      try { return await fs.realpath(root); } catch { return root; }
    }));
    if (!allowedRoots.some((root) => inside(root, target))) {
      const error = new Error("Path is outside configured workspace roots");
      error.statusCode = 403;
      throw error;
    }
    return target;
  }

  async function resolveForWrite(input) {
    const absolute = path.resolve(input);
    const parent = await resolveExisting(path.dirname(absolute));
    const target = path.join(parent, path.basename(absolute));
    if (!normalizedRoots.some((root) => inside(root, target))) {
      const error = new Error("Path is outside configured workspace roots");
      error.statusCode = 403;
      throw error;
    }
    return target;
  }

  return { roots: normalizedRoots, resolveExisting, resolveForWrite };
}

module.exports = { createWorkspaceGuard };
