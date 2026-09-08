import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChangedFileTree,
  parseGitStatus,
} from "../src/lib/workspace-tree.ts";

test("changed files are grouped by directory", () => {
  const tree = buildChangedFileTree(
    "/repo",
    parseGitStatus(" M src/App.tsx\n?? README.md\n")
  );

  assert.equal(tree[0].name, "src");
  assert.equal(tree[0].children[0].path, "/repo/src/App.tsx");
  assert.equal(tree[1].status, "??");
});
