import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, Claim, LocalState, emptyBoard, emptyLocalState, validateBoard } from "./domain.ts";

export interface RepoScope {
  projectRoot: string;
  gitDir: string;
  boardPath: string;
  statePath: string;
  lockPath: string;
  backupPath: string;
}

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 80;
const LOCK_TIMEOUT_MS = 8_000;

export function canonical(p: string): string {
  return fs.realpathSync.native(p);
}

export function resolveRepository(startCwd: string): RepoScope {
  let current = canonical(startCwd);
  const stat = fs.statSync(current);
  if (!stat.isDirectory()) current = path.dirname(current);
  while (true) {
    const dotGit = path.join(current, ".git");
    if (fs.existsSync(dotGit)) {
      const gitDir = resolveGitDir(current, dotGit);
      return makeScope(current, gitDir);
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No Git repository found from ${startCwd}; project tasks were not created.`);
    current = parent;
  }
}

function resolveGitDir(root: string, dotGit: string): string {
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return canonical(dotGit);
  const content = fs.readFileSync(dotGit, "utf8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/i);
  if (!match) throw new Error(`${dotGit} is not a supported Git indirection file`);
  const target = path.resolve(root, match[1]);
  return canonical(target);
}

function makeScope(root: string, gitDir: string): RepoScope {
  return {
    projectRoot: canonical(root),
    gitDir,
    boardPath: path.join(root, ".pi", "tasks.json"),
    statePath: path.join(gitDir, "pi-project-tasks-state.json"),
    lockPath: path.join(gitDir, "pi-project-tasks.lock"),
    backupPath: path.join(gitDir, "pi-project-tasks.backup.json"),
  };
}

export function readBoard(scope: RepoScope): Board {
  if (!fs.existsSync(scope.boardPath)) return emptyBoard();
  let raw: string;
  try {
    raw = fs.readFileSync(scope.boardPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${scope.boardPath}: ${(error as Error).message}`);
  }
  try {
    return validateBoard(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid task board ${scope.boardPath}: ${(error as Error).message}. Not overwriting.`);
  }
}

export function readLocalState(scope: RepoScope): LocalState {
  if (!fs.existsSync(scope.statePath)) return emptyLocalState();
  try {
    const parsed = JSON.parse(fs.readFileSync(scope.statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyLocalState();
    return { claims: parsed.claims ?? {}, idempotency: parsed.idempotency ?? {} };
  } catch {
    return emptyLocalState();
  }
}

export function writeLocalState(scope: RepoScope, state: LocalState): void {
  fs.mkdirSync(path.dirname(scope.statePath), { recursive: true });
  atomicWriteJson(scope.statePath, state);
}

export async function withLock<T>(scope: RepoScope, fn: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(scope.lockPath), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(scope.lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stale = isLockStale(scope.lockPath);
      if (stale) {
        try { fs.unlinkSync(scope.lockPath); } catch {}
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for project task lock: ${scope.lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    cleanTemps(path.dirname(scope.boardPath));
    return await fn();
  } finally {
    try { fs.unlinkSync(scope.lockPath); } catch {}
  }
}

function isLockStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

export function mutateBoard<T>(scope: RepoScope, mutate: (board: Board, state: LocalState) => T): Promise<T> {
  return withLock(scope, () => {
    const before = fs.existsSync(scope.boardPath) ? readBoard(scope) : emptyBoard();
    const state = readLocalState(scope);
    const result = mutate(before, state);
    const after = readBoardLike(scope, before);
    if (after !== before) writeBoard(scope, after);
    writeLocalState(scope, state);
    return result;
  });
}

function readBoardLike(_scope: RepoScope, board: Board): Board {
  return board;
}

export async function updateBoard<T>(scope: RepoScope, mutate: (board: Board, state: LocalState) => { board: Board; result: T }): Promise<T> {
  return withLock(scope, () => {
    const board = readBoard(scope);
    const state = readLocalState(scope);
    const { board: next, result } = mutate(board, state);
    validateBoard(next);
    writeBoard(scope, next);
    writeLocalState(scope, state);
    return result;
  });
}

export function writeBoard(scope: RepoScope, board: Board): void {
  fs.mkdirSync(path.dirname(scope.boardPath), { recursive: true });
  if (fs.existsSync(scope.boardPath)) {
    try {
      const current = readBoard(scope);
      atomicWriteJson(scope.backupPath, current);
    } catch {}
  }
  atomicWriteJson(scope.boardPath, board);
}

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tasks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function cleanTemps(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!/^\.tasks-.*\.tmp$/.test(entry)) continue;
    const file = path.join(dir, entry);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > 60_000) fs.unlinkSync(file);
    } catch {}
  }
}

export function makeClaim(taskId: string, sessionId?: string, sessionName?: string): Claim {
  return { taskId, sessionId, sessionName, pid: process.pid, hostname: os.hostname(), claimedAt: new Date().toISOString() };
}

export function sameSessionClaim(claim: Claim | undefined, sessionId?: string): boolean {
  return Boolean(claim && sessionId && claim.sessionId === sessionId);
}
