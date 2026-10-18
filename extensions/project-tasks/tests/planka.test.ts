import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlankaConfig, parseMarker, toBoard } from "../planka.ts";

const marker = {
  id: "T-0012",
  planId: "P-0003",
  planTitle: "Online board",
  priority: "high",
  dependencies: ["T-0011"],
  relevantFiles: ["compose.board.yaml"],
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    board: { id: "board" },
    project: { id: "project" },
    lists: [
      { id: "todo", name: "Te doen" },
      { id: "doing", name: "Bezig" },
      { id: "blocked", name: "Geblokkeerd" },
      { id: "done", name: "Klaar" },
    ],
    cards: [{ id: "card", listId: "done", name: "T-0012 Koppel agent", description: `Menselijke tekst\n\n<!-- letslets-task:${JSON.stringify(marker)} -->`, createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T11:00:00Z" }],
    labels: [{ id: "cancelled", name: "Geannuleerd" }],
    cardLabels: [],
    taskLists: [{ id: "checks", cardId: "card", name: "Controlepunten" }],
    checklistTasks: [{ id: "check", taskListId: "checks", name: "Werkt", position: 65536 }],
    users: [], cardMemberships: [],
    ...overrides,
  } as any;
}

test("reads tracked PLANKA config without a secret", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planka-config-"));
  fs.mkdirSync(path.join(root, ".pi"));
  fs.writeFileSync(path.join(root, ".pi", "project-tasks.json"), JSON.stringify({ provider: "planka", baseUrl: "https://board.example", projectName: "P", boardName: "B", apiKeyEnv: "PLANKA_API_KEY" }));
  assert.equal(loadPlankaConfig(root)?.apiKeyEnv, "PLANKA_API_KEY");
});

test("maps PLANKA cards, lists and checklists to task domain", () => {
  const board = toBoard(snapshot());
  assert.equal(board.tasks[0].id, "T-0012");
  assert.equal(board.tasks[0].status, "done");
  assert.equal(board.tasks[0].description, "Menselijke tekst");
  assert.deepEqual(board.tasks[0].acceptanceCriteria, ["Werkt"]);
  assert.equal(board.plans[0].title, "Online board");
});

test("cancelled label preserves cancelled status and duplicate IDs fail closed", () => {
  const cancelled = snapshot({ cardLabels: [{ cardId: "card", labelId: "cancelled" }] });
  assert.equal(toBoard(cancelled).tasks[0].status, "cancelled");
  assert.throws(() => toBoard(snapshot({ cards: [...snapshot().cards, { ...snapshot().cards[0], id: "other" }] })), /Duplicate PLANKA cards/);
});

test("ignores ordinary cards without a task marker", () => {
  assert.equal(toBoard(snapshot({ cards: [{ id: "note", listId: "todo", name: "Note" }] })).tasks.length, 0);
  assert.equal(parseMarker("not json"), undefined);
});
