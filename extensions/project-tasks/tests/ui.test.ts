import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, emptyBoard, formatTaskLine } from "../domain.ts";
import { filterTasks, selectFilter, selectTask, taskDetails } from "../ui.ts";

function fixture() {
  return createPlan(emptyBoard(), { title: "P", tasks: [
    { key: "a", title: "A" },
    { key: "b", title: "B" },
    { title: "C", dependencies: ["a", "b"] },
  ] }).board;
}

test("waiting tasks become ready only when all dependencies are done", () => {
  const board = fixture();
  assert.deepEqual(filterTasks(board, "waiting", {}).map((t) => t.id), ["T-0003"]);
  board.tasks[0].status = "done";
  assert.match(formatTaskLine(board.tasks[2], board.plans[0], board), /\[waiting on T-0002\]/);
  assert.match(taskDetails(board, board.tasks[2]), /Waiting on: T-0002/);
  board.tasks[1].status = "done";
  assert.deepEqual(filterTasks(board, "waiting", {}), []);
  assert.deepEqual(filterTasks(board, "ready", {}).map((t) => t.id), ["T-0003"]);
  assert.doesNotMatch(formatTaskLine(board.tasks[2], board.plans[0], board), /waiting on/);
  assert.equal(board.tasks[2].status, "todo");
});

test("cancelled prerequisites still wait; other statuses are not waiting tasks", () => {
  const board = fixture();
  board.tasks[0].status = "cancelled";
  assert.equal(filterTasks(board, "waiting", {}).length, 1);
  for (const status of ["blocked", "in_progress", "done", "cancelled"] as const) {
    board.tasks[2].status = status;
    assert.deepEqual(filterTasks(board, "waiting", {}), []);
    assert.doesNotMatch(formatTaskLine(board.tasks[2], board.plans[0], board), /waiting on/);
  }
  board.tasks[2].status = "blocked";
  assert.deepEqual(filterTasks(board, "blocked", {}).map((t) => t.id), ["T-0003"]);
});

test("waiting picker maps its label and all-task entries show dependencies", async () => {
  const board = fixture();
  const ctx = { ui: { select: async (_title: string, labels: string[]) => {
    assert.ok(labels.includes("Waiting on dependencies"));
    return "Waiting on dependencies";
  } } } as any;
  assert.equal(await selectFilter(ctx), "waiting");
  ctx.ui.select = async (_title: string, labels: string[]) => {
    assert.match(labels[2], /waiting on T-0001, T-0002/);
    return labels[2];
  };
  assert.equal((await selectTask(ctx, board, filterTasks(board, "all", {})))?.id, "T-0003");
  ctx.ui.select = async () => undefined;
  assert.equal(await selectFilter(ctx), undefined);
});
