import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, emptyBoard, readyTasks, stripControls, transitionTask, validateBoard } from "../domain.ts";

test("empty-board initialization and deterministic plan ids", () => {
  const created = createPlan(emptyBoard(), { title: "Plan", tasks: [{ key: "a", title: "A" }, { key: "b", title: "B", dependencies: ["a"] }] });
  assert.equal(created.plan.id, "P-0001");
  assert.deepEqual(created.tasks.map((t) => t.id), ["T-0001", "T-0002"]);
  assert.deepEqual(created.tasks[1].dependencies, ["T-0001"]);
  assert.equal(JSON.stringify(created.board, null, 2).endsWith("}"), true);
});

test("future schema and malformed dependencies fail", () => {
  assert.throws(() => validateBoard({ ...emptyBoard(), schemaVersion: 99 as any }), /unsupported/);
  assert.throws(() => createPlan(emptyBoard(), { title: "Plan", tasks: [{ title: "A", dependencies: ["NOPE"] }] }), /missing dependency/);
});

test("dependency cycle validation", () => {
  assert.throws(() => createPlan(emptyBoard(), { title: "Plan", tasks: [{ key: "a", title: "A", dependencies: ["b"] }, { key: "b", title: "B", dependencies: ["a"] }] }), /cycle/);
});

test("transitions enforce required data", () => {
  const task = createPlan(emptyBoard(), { title: "P", tasks: [{ title: "A" }] }).tasks[0];
  const inProgress = transitionTask(task, "in_progress");
  assert.throws(() => transitionTask(inProgress, "done", { summary: "done" }), /verification/);
  assert.equal(transitionTask(inProgress, "blocked", { reason: "waiting" }).status, "blocked");
  assert.equal(transitionTask(inProgress, "done", { summary: "done", notRunReason: "not run" }).status, "done");
});

test("readiness and sanitization", () => {
  const created = createPlan(emptyBoard(), { title: "P", tasks: [{ key: "a", title: "\u001b[31mA" }, { title: "B", dependencies: ["a"] }] });
  assert.equal(stripControls("\u001b[31mred\u001b[0m"), "red");
  assert.deepEqual(readyTasks(created.board).map((t) => t.id), ["T-0001"]);
});
