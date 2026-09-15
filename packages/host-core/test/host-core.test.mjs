import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationLedger,
  ProjectService,
  SessionCoordinator,
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
    roots: ["/workspace"],
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

test("Session coordinator opens one runtime for multiple presentation IDs", async () => {
  let opens = 0;
  let closes = 0;
  const sessionRuntime = {
    abort: async () => undefined,
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    isStreaming: false,
    prompt: async () => undefined,
    sessionId: "durable-session",
    sessionPath: "/sessions/session.sqlite",
    subscribe: () => () => undefined,
  };
  const coordinator = new SessionCoordinator({
    listSessions: async () => [],
    openSession: () => {
      opens += 1;
      return Promise.resolve(sessionRuntime);
    },
  });

  const first = await coordinator.attach({
    cwd: "/workspace/project",
    sessionId: "presentation-a",
    sessionPath: sessionRuntime.sessionPath,
  });
  const second = await coordinator.attach({
    cwd: "/workspace/project",
    sessionId: "presentation-b",
    sessionPath: sessionRuntime.sessionPath,
  });

  assert.equal(first.runtime, second.runtime);
  assert.equal(opens, 1);
  first.detach();
  first.detach();
  second.detach();
  await coordinator.close();
  assert.equal(closes, 1);
});
