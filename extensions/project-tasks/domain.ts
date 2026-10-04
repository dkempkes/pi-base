export const SCHEMA_VERSION = 1;

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  planId: string;
  title: string;
  description: string;
  priority: Priority;
  dependencies: string[];
  relevantFiles: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  blockedReason?: string;
  completionSummary?: string;
  verificationEvidence?: string;
  notRunReason?: string;
}

export interface Plan {
  id: string;
  title: string;
  summary: string;
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  schemaVersion: 1;
  revision: number;
  nextPlanNumber: number;
  nextTaskNumber: number;
  plans: Plan[];
  tasks: Task[];
}

export interface Claim {
  taskId: string;
  sessionId?: string;
  sessionName?: string;
  pid: number;
  hostname: string;
  claimedAt: string;
}

export interface LocalState {
  claims: Record<string, Claim>;
  idempotency: Record<string, { planId: string; taskIds: Record<string, string> }>;
}

export interface NewTaskInput {
  key?: string;
  title: string;
  description?: string;
  priority?: Priority;
  dependencies?: string[];
  relevantFiles?: string[];
  acceptanceCriteria?: string[];
}

export interface CreatePlanInput {
  idempotencyKey?: string;
  title: string;
  summary?: string;
  tasks: NewTaskInput[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function emptyBoard(): Board {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, nextPlanNumber: 1, nextTaskNumber: 1, plans: [], tasks: [] };
}

export function emptyLocalState(): LocalState {
  return { claims: {}, idempotency: {} };
}

export function stripControls(value: string): string {
  return value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

function cleanText(value: unknown, field: string, max = 4000, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = stripControls(value);
  if (required && !text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function cleanStringArray(value: unknown, field: string, maxItems = 50, maxLen = 1000): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maxItems) throw new Error(`${field} has too many entries`);
  return value.map((item, i) => cleanText(item, `${field}[${i}]`, maxLen)).filter(Boolean);
}

export function normalizePriority(value: unknown): Priority {
  const p = value ?? "normal";
  if (p === "low" || p === "normal" || p === "high" || p === "urgent") return p;
  throw new Error(`invalid priority: ${String(value)}`);
}

export function validateBoard(board: unknown): Board {
  if (!board || typeof board !== "object") throw new Error("task board must be an object");
  const b = board as Board;
  if (b.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported task board schemaVersion: ${(b as any).schemaVersion}`);
  if (!Number.isInteger(b.revision) || b.revision < 0) throw new Error("invalid revision");
  if (!Number.isInteger(b.nextPlanNumber) || b.nextPlanNumber < 1) throw new Error("invalid nextPlanNumber");
  if (!Number.isInteger(b.nextTaskNumber) || b.nextTaskNumber < 1) throw new Error("invalid nextTaskNumber");
  if (!Array.isArray(b.plans) || !Array.isArray(b.tasks)) throw new Error("plans and tasks must be arrays");

  const planIds = new Set<string>();
  for (const plan of b.plans) {
    cleanText(plan.id, "plan.id", 40);
    if (planIds.has(plan.id)) throw new Error(`duplicate plan id ${plan.id}`);
    planIds.add(plan.id);
    cleanText(plan.title, "plan.title", 300);
    cleanText(plan.summary ?? "", "plan.summary", 4000, false);
    if (!Array.isArray(plan.taskIds)) throw new Error(`plan ${plan.id} taskIds must be an array`);
  }

  const taskIds = new Set<string>();
  for (const task of b.tasks) {
    cleanText(task.id, "task.id", 40);
    if (taskIds.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    taskIds.add(task.id);
    if (!planIds.has(task.planId)) throw new Error(`task ${task.id} references missing plan ${task.planId}`);
    cleanText(task.title, "task.title", 300);
    cleanText(task.description ?? "", "task.description", 8000, false);
    normalizePriority(task.priority);
    if (!["todo", "in_progress", "blocked", "done", "cancelled"].includes(task.status)) throw new Error(`invalid status for ${task.id}`);
    if (!Number.isInteger(task.version) || task.version < 1) throw new Error(`invalid version for ${task.id}`);
    if (!Array.isArray(task.dependencies)) throw new Error(`dependencies for ${task.id} must be an array`);
    for (const dep of task.dependencies) {
      if (dep === task.id) throw new Error(`task ${task.id} depends on itself`);
      if (!taskIds.has(dep) && !b.tasks.some((t) => t.id === dep)) throw new Error(`task ${task.id} references missing dependency ${dep}`);
    }
  }
  validateNoCycles(b);
  return b;
}

export function validateNoCycles(board: Board): void {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of board.tasks) visit(task.id);
}

export function unfinishedDependencies(task: Task, board: Board): string[] {
  const done = new Set(board.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return task.dependencies.filter((id) => !done.has(id));
}

export function waitingTasks(board: Board): Task[] {
  return board.tasks.filter((t) => t.status === "todo" && unfinishedDependencies(t, board).length > 0);
}

export function readyTasks(board: Board, claims: Record<string, Claim> = {}): Task[] {
  const done = new Set(board.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return board.tasks.filter((t) => t.status === "todo" && t.dependencies.every((d) => done.has(d)) && !claims[t.id]);
}

export function canSelect(task: Task, board: Board, claims: Record<string, Claim> = {}): boolean {
  return readyTasks(board, claims).some((t) => t.id === task.id);
}

export function transitionTask(task: Task, next: TaskStatus, data: { reason?: string; summary?: string; verification?: string; notRunReason?: string; forceReopenDone?: boolean } = {}): Task {
  const from = task.status;
  const t: Task = { ...task, version: task.version + 1, updatedAt: nowIso() };
  if (from === "todo" && next === "in_progress") return { ...t, status: next };
  if (from === "in_progress" && next === "todo") return { ...t, status: next };
  if (from === "in_progress" && next === "blocked") {
    const reason = cleanText(data.reason, "blocked reason", 2000);
    return { ...t, status: next, blockedReason: reason };
  }
  if (from === "in_progress" && next === "done") {
    const summary = cleanText(data.summary, "completion summary", 4000);
    const verificationEvidence = cleanText(data.verification, "verification evidence", 4000, false);
    const notRunReason = cleanText(data.notRunReason, "not run reason", 2000, false);
    if (!verificationEvidence && !notRunReason) throw new Error("verification evidence or not-run reason is required");
    return { ...t, status: next, completionSummary: summary, verificationEvidence: verificationEvidence || undefined, notRunReason: notRunReason || undefined };
  }
  if (from === "blocked" && next === "todo") return { ...t, status: next, blockedReason: undefined };
  if (from === "done" && next === "todo" && data.forceReopenDone) return { ...t, status: next };
  if ((from === "todo" || from === "in_progress" || from === "blocked") && next === "cancelled") return { ...t, status: next };
  throw new Error(`unsupported transition ${from} -> ${next}`);
}

export function createPlan(board: Board, input: CreatePlanInput): { board: Board; plan: Plan; tasks: Task[] } {
  const at = nowIso();
  const planId = `P-${String(board.nextPlanNumber).padStart(4, "0")}`;
  let nextTaskNumber = board.nextTaskNumber;
  const keyToId = new Map<string, string>();
  for (const task of input.tasks) {
    if (task.key) keyToId.set(task.key, `T-${String(nextTaskNumber).padStart(4, "0")}`);
    nextTaskNumber++;
  }
  nextTaskNumber = board.nextTaskNumber;
  const tasks: Task[] = input.tasks.map((task, index) => {
    const id = `T-${String(nextTaskNumber++).padStart(4, "0")}`;
    const dependencies = (task.dependencies ?? []).map((dep) => keyToId.get(dep) ?? dep);
    return {
      id,
      planId,
      title: cleanText(task.title, `tasks[${index}].title`, 300),
      description: cleanText(task.description ?? "", `tasks[${index}].description`, 8000, false),
      priority: normalizePriority(task.priority),
      dependencies,
      relevantFiles: cleanStringArray(task.relevantFiles, `tasks[${index}].relevantFiles`, 100, 500),
      acceptanceCriteria: cleanStringArray(task.acceptanceCriteria, `tasks[${index}].acceptanceCriteria`, 50, 1000),
      status: "todo",
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
  });
  const plan: Plan = { id: planId, title: cleanText(input.title, "title", 300), summary: cleanText(input.summary ?? "", "summary", 4000, false), taskIds: tasks.map((t) => t.id), createdAt: at, updatedAt: at };
  const nextBoard: Board = { ...board, revision: board.revision + 1, nextPlanNumber: board.nextPlanNumber + 1, nextTaskNumber, plans: [...board.plans, plan], tasks: [...board.tasks, ...tasks] };
  validateBoard(nextBoard);
  return { board: nextBoard, plan, tasks };
}

export function formatTaskLine(task: Task, plan?: Plan, board?: Board): string {
  const pending = board ? unfinishedDependencies(task, board) : [];
  const waiting = task.status === "todo" && pending.length ? ` [waiting on ${pending.join(", ")}]` : "";
  return `${task.id} [${task.status}] ${task.priority} — ${plan?.title ?? task.planId}: ${stripControls(task.title)}${waiting}`;
}
