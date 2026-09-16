import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationLedger,
  ProjectService,
  WorkspaceService,
} from "../dist/index.js";

test("Project service resolves and deduplicates canonical workspaces", async () => {
  let projects = [];
  const repository = {
    list: async () => projects,
    replace: (next) => {
      projects = [...next];
      return Promise.resolve();
    },
  };
  const workspace = new WorkspaceService({
    resolveExisting: async () => "/workspace/project",
  });
  const service = new ProjectService(repository, workspace, () => "project-1");

  const first = await service.add({ cwd: "/workspace/./project" });
  const second = await service.add({ cwd: "/workspace/project" });

  assert.equal(first, second);
  assert.deepEqual(projects, [
    { cwd: "/workspace/project", id: "project-1", name: "project" },
  ]);
});

test("Operation ledger persists acceptance before dispatch and deduplicates", async () => {
  const operations = new Map();
  const order = [];
  const ledger = new OperationLedger({
    get: async (id) => operations.get(id),
    putIfAbsent: (id, operationResult) => {
      if (operations.has(id)) {
        return Promise.resolve({
          inserted: false,
          result: operations.get(id),
        });
      }
      operations.set(id, operationResult);
      order.push("persist");
      return Promise.resolve({ inserted: true, result: operationResult });
    },
  });
  const dispatch = () => {
    order.push("dispatch");
    return Promise.resolve();
  };
  const result = { sessionId: "session-1" };

  assert.deepEqual(
    await ledger.accept("operation-1", result, dispatch),
    result
  );
  assert.deepEqual(
    await ledger.accept("operation-1", result, dispatch),
    result
  );
  assert.deepEqual(order, ["persist", "dispatch"]);
});
