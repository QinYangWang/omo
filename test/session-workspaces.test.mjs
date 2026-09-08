import assert from "node:assert/strict";
import test from "node:test";
import {
  rememberSessionWorkspace,
  sessionWorkspaceId,
} from "../src/lib/session-workspaces.ts";

test("each session keeps its own workspace", () => {
  const first = { cwd: "/one", key: "a", serverId: "local" };
  const second = { cwd: "/two", key: "b", serverId: "local" };
  const contexts = rememberSessionWorkspace(
    rememberSessionWorkspace([], first),
    second
  );

  assert.deepEqual(
    contexts.map(({ id }) => id),
    [sessionWorkspaceId(first), sessionWorkspaceId(second)]
  );
  assert.strictEqual(rememberSessionWorkspace(contexts, second), contexts);
});
