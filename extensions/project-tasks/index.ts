import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Board, Task, canSelect, createPlan, formatTaskLine, readyTasks, stripControls, transitionTask, validateBoard } from "./domain.ts";
import { buildBuilderPrompt, activeTaskContext } from "./prompt.ts";
import { makeClaim, readBoard, readLocalState, resolveRepository, sameSessionClaim, updateBoard, withLock, writeBoard, writeLocalState, type RepoScope } from "./repository.ts";
import { filterTasks, selectFilter, selectTask, taskDetails, type Filter } from "./ui.ts";

type WorkMode = "planner" | "builder";
const ACTIVE_ENTRY = "project-tasks-active";
const STATUS_KEY = "project-tasks";
const Params = Type.Any();

function getMode(pi: ExtensionAPI): WorkMode {
  const query: { mode?: WorkMode } = {};
  pi.events.emit("work-mode:query", query);
  return query.mode === "planner" ? "planner" : "builder";
}

function sessionId(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager.getSessionId(); } catch { return undefined; }
}
function sessionName(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager.getSessionName(); } catch { return undefined; }
}
function scopeFor(ctx: ExtensionContext): RepoScope { return resolveRepository(ctx.cwd); }
function findTask(board: Board, id: string): Task {
  const task = board.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}
function ensureBuilder(pi: ExtensionAPI): void { if (getMode(pi) === "planner") throw new Error("Planner mode may not claim, release, block, complete, or reopen implementation tasks"); }
function replaceTask(board: Board, task: Task): Board {
  return { ...board, revision: board.revision + 1, tasks: board.tasks.map((t) => t.id === task.id ? task : t) };
}
function countStatus(board: Board, status: string): number { return board.tasks.filter((t) => t.status === status).length; }
function shorten(text: string, max = 34): string {
  const clean = stripControls(text).replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
function statusPill(ctx: ExtensionContext, color: Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0], icon: string, count: number, label: string): string {
  const theme = ctx.ui.theme;
  return theme.fg(color, icon) + theme.fg("muted", ` ${count} ${label}`);
}
function boardStatus(ctx: ExtensionContext, board: Board): string {
  const ready = readyTasks(board).length;
  const todo = countStatus(board, "todo");
  const activeCount = countStatus(board, "in_progress");
  const blocked = countStatus(board, "blocked");
  const done = countStatus(board, "done");
  return [
    ctx.ui.theme.fg("toolTitle", ctx.ui.theme.bold("tasks")),
    statusPill(ctx, ready ? "success" : "dim", "◆", ready, "ready"),
    statusPill(ctx, todo ? "muted" : "dim", "◌", todo, "todo"),
    statusPill(ctx, activeCount ? "accent" : "dim", "⚡", activeCount, "active"),
    statusPill(ctx, blocked ? "warning" : "dim", "■", blocked, "blocked"),
    statusPill(ctx, done ? "success" : "dim", "✓", done, "done"),
  ].join(ctx.ui.theme.fg("dim", " • "));
}
function activeStatus(ctx: ExtensionContext, board: Board, taskId: string): string {
  const task = board.tasks.find((t) => t.id === taskId);
  const theme = ctx.ui.theme;
  if (!task) return theme.fg("warning", `⚡ ${taskId}`) + theme.fg("muted", " missing");
  const priorityColor: Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0] = task.priority === "urgent" || task.priority === "high" ? "warning" : "muted";
  return [
    theme.fg("accent", "⚡"),
    theme.fg("toolTitle", theme.bold(task.id)),
    theme.fg("accent", "active"),
    theme.fg(priorityColor, task.priority),
    theme.fg("muted", shorten(task.title)),
  ].join(theme.fg("dim", " "));
}
function colorizeTaskText(text: string, theme: ExtensionContext["ui"]["theme"]): string {
  return text.split("\n").map((line) => {
    if (line.includes("[in_progress]")) return theme.fg("accent", line);
    if (line.includes("[blocked]")) return theme.fg("warning", line);
    if (line.includes("[done]")) return theme.fg("success", line);
    if (line.includes("[cancelled]")) return theme.fg("dim", line);
    if (line.includes("[todo]")) return theme.fg("muted", line);
    return theme.fg("muted", line);
  }).join("\n");
}
function compactResult(text: string, details: unknown) { return { content: [{ type: "text" as const, text }], details }; }

export default function projectTasksExtension(pi: ExtensionAPI): void {
  let active: { projectRoot: string; activeTaskId: string } | undefined;
  let watcher: fs.FSWatcher | undefined;
  let currentCtx: ExtensionContext | undefined;

  function setActive(ctx: ExtensionContext, scope: RepoScope, taskId?: string) {
    active = taskId ? { projectRoot: scope.projectRoot, activeTaskId: taskId } : undefined;
    pi.appendEntry(ACTIVE_ENTRY, active ?? { projectRoot: scope.projectRoot, activeTaskId: undefined });
    refreshStatus(ctx);
  }

  function refreshStatus(ctx: ExtensionContext) {
    try {
      const scope = scopeFor(ctx);
      const board = readBoard(scope);
      const label = active?.activeTaskId ? activeStatus(ctx, board, active.activeTaskId) : boardStatus(ctx, board);
      ctx.ui.setStatus(STATUS_KEY, label);
    } catch {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  function startWatcher(ctx: ExtensionContext) {
    watcher?.close();
    try {
      const scope = scopeFor(ctx);
      fs.mkdirSync(`${scope.projectRoot}/.pi`, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      watcher = fs.watch(`${scope.projectRoot}/.pi`, () => {
        clearTimeout(timer);
        timer = setTimeout(() => refreshStatus(ctx), 150);
      });
    } catch {}
  }

  pi.registerTool({
    name: "project_tasks",
    label: "Project Tasks",
    description: "Manage the repository-scoped project task board in .pi/tasks.json. Actions: list, get, create_plan, update_task, cancel_task, claim, release, block, complete, reopen. create_plan creates ONE task by default, requires explicit prior user approval via approvalConfirmed: true, and multiple tasks require explicit user request plus allowMultipleTasks: true.",
    promptSnippet: "project_tasks: create and coordinate repository-scoped task plans stored in .pi/tasks.json. Creating tasks requires explicit user approval before the tool call; after the user says yes/approved, call create_plan with approvalConfirmed: true. Create exactly one task per user request unless the user explicitly asks for multiple independent tasks; put steps/subtasks inside that single task's description or acceptance criteria.",
    promptGuidelines: ["Use project_tasks instead of editing .pi/tasks.json directly.", "In planner mode, only list/get/create planning metadata; do not claim or complete tasks.", "Before saving tasks, present the proposed task to the user and wait for explicit approval. A simple yes/goedgekeurd is enough; then call create_plan with approvalConfirmed: true so the user is not asked twice.", "When saving a plan, create exactly one task by default. If the work has multiple steps, include them as subtasks/steps inside the task description or acceptance criteria; do not split them into separate displayed tasks.", "Only create multiple tasks when the user explicitly asks for multiple tasks/tickets/issues; then pass allowMultipleTasks: true to create_plan."],
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params: any, _signal, _update, ctx) {
      const action = params?.action;
      if (!action) throw new Error("project_tasks.action is required");
      const scope = scopeFor(ctx);
      const mode = getMode(pi);
      if (mode === "planner" && !["list", "get", "create_plan", "update_task", "cancel_task"].includes(action)) ensureBuilder(pi);

      if (action === "list") {
        const board = readBoard(scope);
        const state = readLocalState(scope);
        const tasks = params.filter === "ready" ? readyTasks(board, state.claims) : filterTasks(board, (params.filter ?? "all") as Filter, state.claims);
        return compactResult(tasks.map((t) => formatTaskLine(t, board.plans.find((p) => p.id === t.planId), board)).join("\n") || "No tasks", { board, tasks, claims: state.claims });
      }
      if (action === "get") {
        const board = readBoard(scope); const state = readLocalState(scope); const task = findTask(board, params.taskId);
        return compactResult(taskDetails(board, task, state.claims[task.id]), { task, claim: state.claims[task.id] });
      }
      if (action === "create_plan") {
        const requestedTasks = Array.isArray(params.tasks) ? params.tasks : [];
        if (requestedTasks.length === 0 || (requestedTasks.length > 1 && params.allowMultipleTasks !== true)) {
          throw new Error("create_plan creates exactly one task by default. Combine steps/subtasks into one task description or acceptance criteria, or pass allowMultipleTasks: true only when the user explicitly asked for multiple separate tasks.");
        }
        if (params.approvalConfirmed !== true) {
          throw new Error("create_plan requires explicit prior user approval. Present the proposed task first, wait for a clear yes/goedgekeurd, then retry with approvalConfirmed: true.");
        }
        const result = await updateBoard(scope, (board, state) => {
          const key = params.idempotencyKey;
          if (key && state.idempotency[key]) {
            const existing = state.idempotency[key];
            return { board, result: { plan: board.plans.find((p) => p.id === existing.planId), tasks: board.tasks.filter((t) => Object.values(existing.taskIds).includes(t.id)), idempotent: true } };
          }
          const created = createPlan(board, { idempotencyKey: key, title: params.title, summary: params.summary, tasks: params.tasks ?? [] });
          if (key) state.idempotency[key] = { planId: created.plan.id, taskIds: Object.fromEntries(created.tasks.map((t, i) => [params.tasks?.[i]?.key ?? t.id, t.id])) };
          return { board: created.board, result: { plan: created.plan, tasks: created.tasks, idempotent: false } };
        });
        return compactResult(`Created plan ${result.plan?.id} with ${result.tasks.length} tasks`, result);
      }
      if (action === "update_task") {
        if (mode === "builder") throw new Error("Builder may not silently rewrite task scope or acceptance criteria");
        const result = await updateBoard(scope, (board) => {
          const task = findTask(board, params.taskId);
          if (task.status !== "todo") throw new Error("Planner may only revise unstarted tasks");
          if (params.expectedVersion && task.version !== params.expectedVersion) throw new Error("stale task version");
          const next: Task = { ...task, title: params.title ?? task.title, description: params.description ?? task.description, priority: params.priority ?? task.priority, relevantFiles: params.relevantFiles ?? task.relevantFiles, acceptanceCriteria: params.acceptanceCriteria ?? task.acceptanceCriteria, dependencies: params.dependencies ?? task.dependencies, version: task.version + 1, updatedAt: new Date().toISOString() };
          const nextBoard = replaceTask(board, next); validateBoard(nextBoard); return { board: nextBoard, result: next };
        });
        return compactResult(`Updated ${result.id}`, { task: result });
      }
      if (action === "cancel_task") {
        const result = await updateBoard(scope, (board) => {
          const task = findTask(board, params.taskId);
          if (task.status === "done") throw new Error("done tasks must be explicitly reopened before cancellation");
          const next = transitionTask(task, "cancelled");
          return { board: replaceTask(board, next), result: next };
        });
        return compactResult(`Cancelled ${result.id}`, { task: result });
      }

      ensureBuilder(pi);
      if (action === "claim") {
        const result = await updateBoard(scope, (board, state) => {
          const task = findTask(board, params.taskId);
          const existing = state.claims[task.id];
          if (existing && !sameSessionClaim(existing, sessionId(ctx)) && !params.takeover) throw new Error(`Task already claimed by ${existing.hostname}/${existing.pid} ${existing.sessionName ?? existing.sessionId ?? ""}`);
          if (!canSelect(task, board, existing && !sameSessionClaim(existing, sessionId(ctx)) ? state.claims : Object.fromEntries(Object.entries(state.claims).filter(([id]) => id !== task.id)))) throw new Error(`${task.id} is not ready to claim`);
          state.claims[task.id] = makeClaim(task.id, sessionId(ctx), sessionName(ctx));
          const next = task.status === "todo" ? transitionTask(task, "in_progress") : task;
          return { board: replaceTask(board, next), result: next };
        });
        setActive(ctx, scope, result.id);
        return compactResult(`Claimed ${result.id}`, { task: result });
      }
      if (["release", "block", "complete", "reopen"].includes(action)) {
        const result = await updateBoard(scope, (board, state) => {
          const task = findTask(board, params.taskId);
          const claim = state.claims[task.id];
          if ((action === "release" || action === "block" || action === "complete") && claim && !sameSessionClaim(claim, sessionId(ctx)) && !params.takeover) throw new Error(`Task claimed by another session: ${claim.hostname}/${claim.pid}`);
          let next: Task;
          if (action === "release") next = transitionTask(task, "todo");
          else if (action === "block") next = transitionTask(task, "blocked", { reason: params.reason });
          else if (action === "complete") next = transitionTask(task, "done", { summary: params.summary, verification: params.verificationEvidence, notRunReason: params.notRunReason });
          else next = transitionTask(task, "todo", { forceReopenDone: Boolean(params.confirmDoneReopen) });
          delete state.claims[task.id];
          return { board: replaceTask(board, next), result: next };
        });
        if (active?.activeTaskId === result.id) setActive(ctx, scope, undefined);
        return compactResult(`${action} ${result.id}`, { task: result });
      }
      throw new Error(`Unknown project_tasks action: ${action}`);
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("🗂 project_tasks ")) + theme.fg("accent", String((args as any).action ?? "")), 0, 0); },
    renderResult(result, _options, theme) { const text = result.content[0]?.type === "text" ? result.content[0].text : ""; return new Text(colorizeTaskText(text, theme as any), 0, 0); },
  });

  async function startTask(ctx: any, taskId: string) {
    if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy; wait before starting a task", "warning"); return; }
    const scope = scopeFor(ctx);
    let board = readBoard(scope); let state = readLocalState(scope); let task = findTask(board, taskId);
    ctx.ui.notify(taskDetails(board, task, state.claims[task.id]), "info");
    if (ctx.hasUI) { const ok = await ctx.ui.confirm(`Start ${task.id}?`, task.title); if (!ok) return; }
    const claimed = await updateBoard(scope, (latest, local) => {
      const t = findTask(latest, taskId);
      const existing = local.claims[t.id];
      if (existing && !sameSessionClaim(existing, sessionId(ctx))) throw new Error(`Task already claimed by ${existing.hostname}/${existing.pid}`);
      if (!canSelect(t, latest, Object.fromEntries(Object.entries(local.claims).filter(([id]) => id !== t.id)))) throw new Error(`${t.id} is no longer ready`);
      local.claims[t.id] = makeClaim(t.id, sessionId(ctx), sessionName(ctx));
      const next = t.status === "todo" ? transitionTask(t, "in_progress") : t;
      return { board: replaceTask(latest, next), result: { board: replaceTask(latest, next), task: next } };
    });
    setActive(ctx, scope, claimed.task.id);
    pi.sendUserMessage(buildBuilderPrompt(claimed.board, claimed.task));
  }

  pi.registerCommand("tasks", {
    description: "Browse and start repository project tasks",
    getArgumentCompletions: (prefix) => ["show", "start", "ready", "waiting", "all", "blocked", "in_progress", "completed"].filter((v) => v.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const [cmd, id] = args.trim().split(/\s+/);
        const scope = scopeFor(ctx);
        if (cmd === "show" && id) { const board = readBoard(scope); const state = readLocalState(scope); ctx.ui.notify(taskDetails(board, findTask(board, id), state.claims[id]), "info"); return; }
        if (cmd === "start" && id) { await startTask(ctx, id); return; }
        const board = readBoard(scope); const state = readLocalState(scope);
        const filter = (cmd && ["ready", "waiting", "all", "blocked", "in_progress", "completed"].includes(cmd) ? cmd : undefined) as Filter | undefined ?? (ctx.hasUI ? await selectFilter(ctx) : "ready");
        if (!filter) return;
        const task = await selectTask(ctx, board, filterTasks(board, filter, state.claims));
        if (!task) return;
        ctx.ui.notify(taskDetails(board, task, state.claims[task.id]), "info");
        if (canSelect(task, board, state.claims)) await startTask(ctx, task.id);
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const entry = ctx.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === ACTIVE_ENTRY).at(-1) as any;
    active = entry?.data?.activeTaskId ? entry.data : undefined;
    startWatcher(ctx); refreshStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => { currentCtx = ctx; refreshStatus(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { watcher?.close(); watcher = undefined; ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!active) return;
    try {
      const scope = scopeFor(ctx); if (scope.projectRoot !== active.projectRoot) return;
      const board = readBoard(scope); const state = readLocalState(scope); const task = findTask(board, active.activeTaskId); const claim = state.claims[task.id];
      if (!["in_progress"].includes(task.status) || (claim && !sameSessionClaim(claim, sessionId(ctx)))) { active = undefined; return; }
      return { message: { customType: "project-tasks-active-context", content: activeTaskContext(board, task), display: false } };
    } catch { active = undefined; }
  });
  pi.on("context", async (event) => ({ messages: event.messages.filter((m: any) => m.customType !== "project-tasks-active-context") }));
}
