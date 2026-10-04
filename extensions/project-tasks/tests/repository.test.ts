import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyBoard } from "../domain.ts";
import { atomicWriteJson, readBoard, resolveRepository, updateBoard } from "../repository.ts";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-tasks-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

test("repository root resolution and empty board", () => {
  const repo = tempRepo();
  const sub = path.join(repo, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  const scope = resolveRepository(sub);
  assert.equal(scope.projectRoot, fs.realpathSync.native(repo));
  assert.deepEqual(readBoard(scope), emptyBoard());
});

test("git worktree indirection", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-tasks-wt-"));
  const gitdir = path.join(repo, "realgit");
  fs.mkdirSync(gitdir);
  fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${gitdir}\n`);
  const scope = resolveRepository(repo);
  assert.equal(scope.gitDir, fs.realpathSync.native(gitdir));
});

test("atomic write and updateBoard", async () => {
  const repo = tempRepo();
  const scope = resolveRepository(repo);
  atomicWriteJson(scope.boardPath, emptyBoard());
  const rev = await updateBoard(scope, (board) => ({ board: { ...board, revision: board.revision + 1 }, result: board.revision + 1 }));
  assert.equal(rev, 1);
  assert.equal(readBoard(scope).revision, 1);
});

test("malformed board is not overwritten", () => {
  const repo = tempRepo();
  const scope = resolveRepository(repo);
  fs.mkdirSync(path.dirname(scope.boardPath), { recursive: true });
  fs.writeFileSync(scope.boardPath, "{bad json");
  assert.throws(() => readBoard(scope), /Invalid task board/);
});
