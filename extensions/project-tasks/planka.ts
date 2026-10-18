import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Board, Claim, Plan, Priority, Task, TaskStatus } from "./domain.ts";
import { canSelect, formatTaskLine, readyTasks, stripControls } from "./domain.ts";
import { activeTaskContext } from "./prompt.ts";
import { filterTasks, taskDetails, type Filter } from "./ui.ts";
import { makeClaim, readLocalState, resolveRepository, sameSessionClaim, withLock, writeLocalState, type RepoScope } from "./repository.ts";

const ACTIVE_ENTRY = "project-tasks-active";
const STATUS_KEY = "project-tasks";
const POSITION_STEP = 65536;
const MARKER_START = "<!-- letslets-task:";
const MARKER_END = " -->";
const LIST_BY_STATUS: Record<TaskStatus, string> = {
  todo: "Te doen",
  in_progress: "Bezig",
  blocked: "Geblokkeerd",
  done: "Klaar",
  cancelled: "Klaar",
};
const STATUS_BY_LIST: Record<string, TaskStatus> = {
  "Te doen": "todo",
  Bezig: "in_progress",
  Geblokkeerd: "blocked",
  Klaar: "done",
};

type WorkMode = "planner" | "builder";
type Json = Record<string, any>;

export interface PlankaConfig {
  provider: "planka";
  baseUrl: string;
  projectName: string;
  boardName: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
}

interface Marker {
  id: string;
  planId: string;
  planTitle?: string;
  priority?: Priority;
  dependencies?: string[];
  relevantFiles?: string[];
  acceptanceCriteria?: string[];
  idempotencyKey?: string;
  taskKey?: string;
  taskIndex?: number;
}

interface Snapshot {
  board: Json;
  project: Json;
  lists: Json[];
  cards: Json[];
  labels: Json[];
  cardLabels: Json[];
  taskLists: Json[];
  checklistTasks: Json[];
  users: Json[];
  cardMemberships: Json[];
}

function getMode(pi: ExtensionAPI): WorkMode {
  const query: { mode?: WorkMode } = {};
  pi.events.emit("work-mode:query", query);
  return query.mode === "planner" ? "planner" : "builder";
}
function ensureBuilder(pi: ExtensionAPI): void {
  if (getMode(pi) === "planner") throw new Error("Planner mode may not claim, release, block, complete, or reopen implementation tasks");
}
function sessionId(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager.getSessionId(); } catch { return undefined; }
}
function sessionName(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager.getSessionName(); } catch { return undefined; }
}
function compactResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
function scopeFor(ctx: ExtensionContext): RepoScope { return resolveRepository(ctx.cwd); }
function findTask(board: Board, id: string): Task {
  const task = board.tasks.find((item) => item.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}
export function parseMarker(description: unknown): Marker | undefined {
  if (typeof description !== "string") return undefined;
  const start = description.lastIndexOf(MARKER_START);
  if (start < 0) return undefined;
  const end = description.indexOf(MARKER_END, start);
  if (end < 0) return undefined;
  try {
    const value = JSON.parse(description.slice(start + MARKER_START.length, end));
    return value && /^T-\d+$/.test(value.id) && /^P-\d+$/.test(value.planId) ? value : undefined;
  } catch { return undefined; }
}
function withoutMarker(description: unknown): string {
  if (typeof description !== "string") return "";
  const start = description.lastIndexOf(MARKER_START);
  return (start < 0 ? description : description.slice(0, start)).trim();
}
function markerText(marker: Marker): string {
  return `${MARKER_START}${JSON.stringify(marker)}${MARKER_END}`;
}
function withMarker(description: string, marker: Marker): string {
  return [description.trim(), markerText(marker)].filter(Boolean).join("\n\n");
}
function taskNumber(id: string): number { return Number(id.slice(2)); }
function nextId(prefix: "T" | "P", ids: string[]): string {
  const max = ids.reduce((result, id) => Math.max(result, Number(id.slice(2)) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}
function versionFrom(card: Json): number {
  const milliseconds = Date.parse(card.updatedAt ?? card.createdAt ?? "");
  return Number.isFinite(milliseconds) ? Math.max(1, Math.floor(milliseconds / 1000)) : 1;
}
function claimFor(taskId: string, state: ReturnType<typeof readLocalState>): Claim | undefined { return state.claims[taskId]; }

export function loadPlankaConfig(root: string): PlankaConfig | undefined {
  const file = path.join(root, ".pi", "project-tasks.json");
  if (!fs.existsSync(file)) return undefined;
  let value: any;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`Invalid ${file}: ${(error as Error).message}`);
  }
  if (value?.provider !== "planka") throw new Error(`Unsupported project task provider in ${file}`);
  for (const key of ["baseUrl", "projectName", "boardName"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${file}: ${key} is required`);
  }
  if (!value.apiKeyEnv && !value.apiKeyFile) throw new Error(`${file}: apiKeyEnv or apiKeyFile is required`);
  return value as PlankaConfig;
}

class PlankaClient {
  private readonly baseUrl: string;
  constructor(private readonly config: PlankaConfig) { this.baseUrl = config.baseUrl.replace(/\/$/, ""); }
  private apiKey(): string {
    const fromEnv = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv]?.trim() : undefined;
    if (fromEnv) return fromEnv;
    if (this.config.apiKeyFile) {
      const file = this.config.apiKeyFile.replace(/^~(?=$|[\\/])/, os.homedir());
      try {
        const text = fs.readFileSync(file, "utf8").trim();
        if (!text) throw new Error("file is empty");
        try { return JSON.parse(text).apiKey ?? text; } catch { return text; }
      } catch (error) { throw new Error(`Unable to read PLANKA API key file ${file}: ${(error as Error).message}`); }
    }
    throw new Error(`PLANKA API key is missing; set ${this.config.apiKeyEnv ?? "the configured secret file"}`);
  }
  async request(method: string, route: string, body?: unknown): Promise<Json> {
    const headers: Record<string, string> = { Accept: "application/json", "x-api-key": this.apiKey() };
    let requestBody: string | undefined;
    if (body !== undefined) { headers["Content-Type"] = "application/json"; requestBody = JSON.stringify(body); }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, { method, headers, body: requestBody, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`PLANKA is unavailable for ${method} ${route}: ${(error as Error).message}. No local fallback was written.`);
    }
    const text = await response.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(`PLANKA ${method} ${route} returned ${response.status}: ${payload.message ?? response.statusText}`);
    return payload;
  }
  async snapshot(): Promise<Snapshot> {
    const projects = await this.request("GET", "/api/projects");
    const project = projects.items?.find((item: Json) => item.name === this.config.projectName);
    if (!project) throw new Error(`PLANKA project not found: ${this.config.projectName}`);
    const board = projects.included?.boards?.find((item: Json) => item.projectId === project.id && item.name === this.config.boardName);
    if (!board) throw new Error(`PLANKA board not found: ${this.config.boardName}`);
    const result = await this.request("GET", `/api/boards/${board.id}`);
    return {
      board: result.item,
      project,
      lists: result.included.lists ?? [], cards: result.included.cards ?? [], labels: result.included.labels ?? [],
      cardLabels: result.included.cardLabels ?? [], taskLists: result.included.taskLists ?? [],
      checklistTasks: result.included.tasks ?? [], users: result.included.users ?? [],
      cardMemberships: result.included.cardMemberships ?? [],
    };
  }
}

export function toBoard(snapshot: Snapshot): Board {
  const listById = new Map(snapshot.lists.map((item) => [item.id, item]));
  const labelById = new Map(snapshot.labels.map((item) => [item.id, item]));
  const planById = new Map<string, Plan>();
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const card of snapshot.cards) {
    const marker = parseMarker(card.description);
    if (!marker) continue;
    if (seen.has(marker.id)) throw new Error(`Duplicate PLANKA cards found for ${marker.id}; refusing to write`);
    seen.add(marker.id);
    const list = listById.get(card.listId);
    let status = STATUS_BY_LIST[list?.name];
    if (!status) throw new Error(`Card ${marker.id} is in unsupported list ${list?.name ?? card.listId}`);
    const cardLabelIds = snapshot.cardLabels.filter((item) => item.cardId === card.id).map((item) => item.labelId);
    if (status === "done" && cardLabelIds.some((id) => labelById.get(id)?.name === "Geannuleerd")) status = "cancelled";
    const taskListIds = snapshot.taskLists.filter((item) => item.cardId === card.id && item.name === "Controlepunten").map((item) => item.id);
    const acceptanceCriteria = snapshot.checklistTasks.filter((item) => taskListIds.includes(item.taskListId)).sort((a, b) => a.position - b.position).map((item) => item.name);
    const createdAt = card.createdAt ?? new Date(0).toISOString();
    const updatedAt = card.updatedAt ?? createdAt;
    tasks.push({
      id: marker.id, planId: marker.planId, title: stripControls(String(card.name).replace(new RegExp(`^${marker.id}\\s*`), "")),
      description: withoutMarker(card.description), priority: marker.priority ?? "normal", dependencies: marker.dependencies ?? [],
      relevantFiles: marker.relevantFiles ?? [], acceptanceCriteria, status, version: versionFrom(card), createdAt, updatedAt,
    });
    if (!planById.has(marker.planId)) {
      planById.set(marker.planId, { id: marker.planId, title: marker.planTitle ?? marker.planId, summary: "", taskIds: [], createdAt, updatedAt });
    }
    planById.get(marker.planId)!.taskIds.push(marker.id);
  }
  tasks.sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
  const plans = [...planById.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 1, revision: Math.max(0, ...tasks.map((item) => item.version)), nextPlanNumber: Number(nextId("P", plans.map((item) => item.id)).slice(2)), nextTaskNumber: Number(nextId("T", tasks.map((item) => item.id)).slice(2)), plans, tasks };
}
function cardFor(snapshot: Snapshot, taskId: string): Json {
  const matches = snapshot.cards.filter((card) => parseMarker(card.description)?.id === taskId);
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate PLANKA cards found for ${taskId}` : `Task not found: ${taskId}`);
  return matches[0];
}
function requiredLists(snapshot: Snapshot): Map<string, Json> {
  const lists = new Map(snapshot.lists.map((item) => [item.name, item]));
  for (const name of Object.values(LIST_BY_STATUS)) if (!lists.has(name)) throw new Error(`Required PLANKA list is missing: ${name}`);
  return lists;
}
function nextPosition(snapshot: Snapshot, listId: string): number {
  return Math.max(0, ...snapshot.cards.filter((item) => item.listId === listId).map((item) => Number(item.position) || 0)) + POSITION_STEP;
}
async function move(client: PlankaClient, snapshot: Snapshot, taskId: string, status: TaskStatus): Promise<void> {
  const card = cardFor(snapshot, taskId);
  const list = requiredLists(snapshot).get(LIST_BY_STATUS[status])!;
  if (card.listId === list.id) return;
  await client.request("PATCH", `/api/cards/${card.id}`, { listId: list.id, position: nextPosition(snapshot, list.id) });
}
async function comment(client: PlankaClient, snapshot: Snapshot, taskId: string, text: string): Promise<void> {
  const card = cardFor(snapshot, taskId);
  const existing = await client.request("GET", `/api/cards/${card.id}/comments`);
  if (existing.items?.some((item: Json) => item.text === text)) return;
  await client.request("POST", `/api/cards/${card.id}/comments`, { text });
}
async function ensureLabel(client: PlankaClient, snapshot: Snapshot, name: string, color = "muddy-grey"): Promise<Json> {
  const existing = snapshot.labels.find((item) => item.name === name);
  if (existing) return existing;
  return (await client.request("POST", `/api/boards/${snapshot.board.id}/labels`, { position: (snapshot.labels.length + 1) * POSITION_STEP, name, color })).item;
}
async function attachLabel(client: PlankaClient, snapshot: Snapshot, card: Json, label: Json): Promise<void> {
  if (!snapshot.cardLabels.some((item) => item.cardId === card.id && item.labelId === label.id)) {
    await client.request("POST", `/api/cards/${card.id}/card-labels`, { labelId: label.id });
  }
}
async function detachLabel(client: PlankaClient, snapshot: Snapshot, card: Json, labelName: string): Promise<void> {
  const label = snapshot.labels.find((item) => item.name === labelName);
  if (label && snapshot.cardLabels.some((item) => item.cardId === card.id && item.labelId === label.id)) {
    await client.request("DELETE", `/api/cards/${card.id}/card-labels/labelId:${label.id}`);
  }
}
async function addChecklist(client: PlankaClient, cardId: string, checks: string[]): Promise<void> {
  if (!checks.length) return;
  const list = (await client.request("POST", `/api/cards/${cardId}/task-lists`, { position: POSITION_STEP, name: "Controlepunten", showOnFrontOfCard: true, hideCompletedTasks: false })).item;
  for (const [index, name] of checks.entries()) await client.request("POST", `/api/task-lists/${list.id}/tasks`, { position: (index + 1) * POSITION_STEP, name, isCompleted: false });
}

export default function registerPlankaProjectTasks(pi: ExtensionAPI, config: PlankaConfig): void {
  const client = new PlankaClient(config);
  let active: { projectRoot: string; activeTaskId: string } | undefined;

  async function read(): Promise<{ snapshot: Snapshot; board: Board }> {
    const snapshot = await client.snapshot();
    return { snapshot, board: toBoard(snapshot) };
  }
  async function state(scope: RepoScope, fn: (value: ReturnType<typeof readLocalState>) => void): Promise<void> {
    await withLock(scope, () => { const value = readLocalState(scope); fn(value); writeLocalState(scope, value); });
  }
  function setActive(ctx: ExtensionContext, scope: RepoScope, taskId?: string): void {
    active = taskId ? { projectRoot: scope.projectRoot, activeTaskId: taskId } : undefined;
    pi.appendEntry(ACTIVE_ENTRY, active ?? { projectRoot: scope.projectRoot, activeTaskId: undefined });
  }
  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    try {
      const { board } = await read();
      const current = active?.activeTaskId ? `${active.activeTaskId} active` : `${readyTasks(board).length} ready · ${board.tasks.filter((item) => item.status === "blocked").length} blocked`;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("toolTitle", ctx.ui.theme.bold("tasks")) + ctx.ui.theme.fg("muted", ` · PLANKA · ${current}`));
    } catch { ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "tasks · PLANKA unavailable")); }
  }

  pi.registerTool({
    name: "project_tasks", label: "Project Tasks (PLANKA)", parameters: Type.Any(), executionMode: "sequential",
    description: "Manage the central PLANKA project task board. Actions: list, get, create_plan, update_task, cancel_task, claim, release, block, complete, reopen. create_plan requires explicit prior approvalConfirmed: true and creates one task unless allowMultipleTasks is explicitly true.",
    promptSnippet: "project_tasks: use the central PLANKA board. New plans require explicit prior user approval and approvalConfirmed: true. Create one displayed task by default.",
    promptGuidelines: ["PLANKA is authoritative; never update .pi/tasks.json as a second board.", "Before create_plan, present the plan and wait for explicit approval.", "Do not retry a failed write blindly; the provider checks idempotency markers first."],
    async execute(_id, params: any, _signal, _update, ctx) {
      const action = params?.action;
      if (!action) throw new Error("project_tasks.action is required");
      const scope = scopeFor(ctx);
      const mode = getMode(pi);
      const current = await read();
      const local = readLocalState(scope);
      if (action === "list") {
        const tasks = params.filter === "ready" ? readyTasks(current.board, local.claims) : filterTasks(current.board, (params.filter ?? "all") as Filter, local.claims);
        return compactResult(tasks.map((item) => formatTaskLine(item, current.board.plans.find((plan) => plan.id === item.planId), current.board)).join("\n") || "No tasks", { board: current.board, tasks, claims: local.claims });
      }
      if (action === "get") {
        const task = findTask(current.board, params.taskId);
        return compactResult(taskDetails(current.board, task, claimFor(task.id, local)), { task, claim: claimFor(task.id, local) });
      }
      if (action === "create_plan") {
        const requested = Array.isArray(params.tasks) ? params.tasks : [];
        if (!requested.length || (requested.length > 1 && params.allowMultipleTasks !== true)) throw new Error("create_plan creates one task by default; combine steps or explicitly allow multiple tasks");
        if (params.approvalConfirmed !== true) throw new Error("create_plan requires explicit prior user approval and approvalConfirmed: true");
        if (!params.idempotencyKey?.trim()) throw new Error("PLANKA create_plan requires a stable idempotencyKey");
        const existing = current.snapshot.cards.map((card) => ({ card, marker: parseMarker(card.description) })).filter((item) => item.marker?.idempotencyKey === params.idempotencyKey);
        if (existing.length > requested.length) throw new Error("More PLANKA cards than expected share this idempotencyKey; refusing to write");
        const planId = existing[0]?.marker!.planId ?? nextId("P", current.board.plans.map((item) => item.id));
        let taskIdNumber = existing.length
          ? Math.min(...existing.map((item) => taskNumber(item.marker!.id) - (item.marker!.taskIndex ?? 0)))
          : Number(nextId("T", current.board.tasks.map((item) => item.id)).slice(2));
        const lists = requiredLists(current.snapshot);
        const priorityNames: Record<Priority, [string, string]> = {
          low: ["Prioriteit: laag", "morning-sky"], normal: ["Prioriteit: normaal", "fresh-salad"],
          high: ["Prioriteit: hoog", "light-orange"], urgent: ["Prioriteit: dringend", "berry-red"],
        };
        const priorityLabels = new Map<Priority, Json>();
        for (const priority of new Set<Priority>(requested.map((item: any) => item.priority ?? "normal"))) {
          const [name, color] = priorityNames[priority];
          priorityLabels.set(priority, await ensureLabel(client, current.snapshot, name, color));
        }
        const created: Task[] = [];
        const keyToId = new Map<string, string>();
        requested.forEach((input: any, index: number) => { if (input.key) keyToId.set(input.key, `T-${String(taskIdNumber + index).padStart(4, "0")}`); });
        for (const [index, input] of requested.entries()) {
          const already = existing.find((item) => (item.marker!.taskIndex ?? 0) === index);
          const id = `T-${String(taskIdNumber + index).padStart(4, "0")}`;
          if (already) {
            if (already.marker!.id !== id) throw new Error(`Idempotent PLANKA retry expected ${id} but found ${already.marker!.id}`);
            continue;
          }
          const marker: Marker = { id, planId, planTitle: params.title, priority: input.priority ?? "normal", dependencies: (input.dependencies ?? []).map((dep: string) => keyToId.get(dep) ?? dep), relevantFiles: input.relevantFiles ?? [], acceptanceCriteria: input.acceptanceCriteria ?? [], idempotencyKey: params.idempotencyKey, taskKey: input.key, taskIndex: index };
          const list = lists.get("Te doen")!;
          const visibleDescription = [stripControls(input.description ?? ""), `**Plan:** ${stripControls(params.title)}`, `**Prioriteit:** ${marker.priority}`].filter(Boolean).join("\n\n");
          const result = await client.request("POST", `/api/lists/${list.id}/cards`, { type: "project", position: nextPosition(current.snapshot, list.id) + index * POSITION_STEP, name: `${id} ${stripControls(input.title)}`, description: withMarker(visibleDescription, marker) });
          await attachLabel(client, current.snapshot, result.item, priorityLabels.get(marker.priority!)!);
          await addChecklist(client, result.item.id, marker.acceptanceCriteria ?? []);
          created.push({ id, planId, title: input.title, description: input.description ?? "", priority: marker.priority!, dependencies: marker.dependencies!, relevantFiles: marker.relevantFiles!, acceptanceCriteria: marker.acceptanceCriteria!, status: "todo", version: 1, createdAt: result.item.createdAt, updatedAt: result.item.updatedAt });
        }
        const total = existing.length + created.length;
        return compactResult(`${created.length ? "Created" : "Found"} plan ${planId} with ${total} task(s) in PLANKA`, { plan: { id: planId, title: params.title }, tasks: created, idempotent: created.length === 0 });
      }
      if (action === "update_task") {
        if (mode === "builder") throw new Error("Builder may not silently rewrite task scope or acceptance criteria");
        const task = findTask(current.board, params.taskId);
        if (task.status !== "todo") throw new Error("Planner may only revise unstarted tasks");
        if (!params.expectedVersion) throw new Error("expectedVersion is required for a PLANKA text update");
        if (task.version !== params.expectedVersion) throw new Error("stale task version; reload before editing");
        const card = cardFor(current.snapshot, task.id); const old = parseMarker(card.description)!;
        const marker: Marker = { ...old, priority: params.priority ?? old.priority, dependencies: params.dependencies ?? old.dependencies, relevantFiles: params.relevantFiles ?? old.relevantFiles, acceptanceCriteria: params.acceptanceCriteria ?? old.acceptanceCriteria };
        await client.request("PATCH", `/api/cards/${card.id}`, { name: `${task.id} ${stripControls(params.title ?? task.title)}`, description: withMarker(stripControls(params.description ?? withoutMarker(card.description)), marker) });
        if (params.acceptanceCriteria) {
          const oldLists = current.snapshot.taskLists.filter((item) => item.cardId === card.id && item.name === "Controlepunten");
          for (const list of oldLists) await client.request("DELETE", `/api/task-lists/${list.id}`);
          await addChecklist(client, card.id, params.acceptanceCriteria);
        }
        return compactResult(`Updated ${task.id} in PLANKA`, { task: { ...task, ...params } });
      }
      if (action === "cancel_task") {
        const task = findTask(current.board, params.taskId); if (task.status === "done") throw new Error("done tasks must be reopened before cancellation");
        const card = cardFor(current.snapshot, task.id); const label = await ensureLabel(client, current.snapshot, "Geannuleerd");
        await attachLabel(client, current.snapshot, card, label); await move(client, current.snapshot, task.id, "cancelled");
        return compactResult(`Cancelled ${task.id} in PLANKA`, { task: { ...task, status: "cancelled" } });
      }
      ensureBuilder(pi);
      if (action === "claim") {
        const task = findTask(current.board, params.taskId); const existing = local.claims[task.id];
        if (existing && !sameSessionClaim(existing, sessionId(ctx)) && !params.takeover) throw new Error(`Task already claimed by ${existing.hostname}/${existing.pid}`);
        if (!canSelect(task, current.board, Object.fromEntries(Object.entries(local.claims).filter(([id]) => id !== task.id)))) throw new Error(`${task.id} is not ready to claim`);
        await move(client, current.snapshot, task.id, "in_progress");
        await state(scope, (value) => { value.claims[task.id] = makeClaim(task.id, sessionId(ctx), sessionName(ctx)); });
        setActive(ctx, scope, task.id); return compactResult(`Claimed ${task.id} in PLANKA`, { task: { ...task, status: "in_progress" } });
      }
      if (["release", "block", "complete", "reopen"].includes(action)) {
        const task = findTask(current.board, params.taskId); const existing = local.claims[task.id];
        if (["release", "block", "complete"].includes(action) && existing && !sameSessionClaim(existing, sessionId(ctx)) && !params.takeover) throw new Error(`Task claimed by another session: ${existing.hostname}/${existing.pid}`);
        if (action === "release") await move(client, current.snapshot, task.id, "todo");
        if (action === "block") { if (!params.reason?.trim()) throw new Error("blocked reason is required"); await comment(client, current.snapshot, task.id, `**Geblokkeerd:** ${stripControls(params.reason)}`); await move(client, current.snapshot, task.id, "blocked"); }
        if (action === "complete") {
          if (!params.summary?.trim()) throw new Error("completion summary is required");
          if (!params.verificationEvidence?.trim() && !params.notRunReason?.trim()) throw new Error("verification evidence or not-run reason is required");
          await comment(client, current.snapshot, task.id, [`**Afronding:** ${stripControls(params.summary)}`, params.verificationEvidence ? `**Controle:** ${stripControls(params.verificationEvidence)}` : `**Niet uitgevoerd:** ${stripControls(params.notRunReason)}`].join("\n\n"));
          await move(client, current.snapshot, task.id, "done");
        }
        if (action === "reopen") {
          if (task.status === "done" && !params.confirmDoneReopen) throw new Error("confirmDoneReopen is required");
          if (task.status === "cancelled") await detachLabel(client, current.snapshot, cardFor(current.snapshot, task.id), "Geannuleerd");
          await move(client, current.snapshot, task.id, "todo");
        }
        await state(scope, (value) => { delete value.claims[task.id]; }); if (active?.activeTaskId === task.id) setActive(ctx, scope);
        return compactResult(`${action} ${task.id} in PLANKA`, { task: { ...task, status: action === "block" ? "blocked" : action === "complete" ? "done" : "todo" } });
      }
      throw new Error(`Unknown project_tasks action: ${action}`);
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("🗂 project_tasks ")) + theme.fg("accent", String((args as any).action ?? "")) + theme.fg("muted", " · PLANKA"), 0, 0); },
    renderResult(result, _options, theme) { const text = result.content[0]?.type === "text" ? result.content[0].text : ""; return new Text(theme.fg("muted", text), 0, 0); },
  });

  pi.registerCommand("tasks", { description: "List central PLANKA project tasks", handler: async (args, ctx) => {
    try {
      const { board } = await read(); const local = readLocalState(scopeFor(ctx)); const filter = (args.trim() || "ready") as Filter;
      const tasks = filterTasks(board, filter, local.claims); ctx.ui.notify(tasks.map((item) => formatTaskLine(item, board.plans.find((plan) => plan.id === item.planId), board)).join("\n") || "No tasks", "info");
    } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
  }});
  pi.on("session_start", async (_event, ctx) => {
    const entry = ctx.sessionManager.getBranch().filter((item: any) => item.type === "custom" && item.customType === ACTIVE_ENTRY).at(-1) as any;
    active = entry?.data?.activeTaskId ? entry.data : undefined; await refreshStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => { await refreshStatus(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { ctx.ui.setStatus(STATUS_KEY, undefined); });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!active) return;
    try {
      const scope = scopeFor(ctx); if (scope.projectRoot !== active.projectRoot) return;
      const { board } = await read(); const task = findTask(board, active.activeTaskId); const local = readLocalState(scope); const claim = local.claims[task.id];
      if (task.status !== "in_progress" || (claim && !sameSessionClaim(claim, sessionId(ctx)))) { active = undefined; return; }
      return { message: { customType: "project-tasks-active-context", content: activeTaskContext(board, task), display: false } };
    } catch { active = undefined; }
  });
  pi.on("context", async (event) => ({ messages: event.messages.filter((message: any) => message.customType !== "project-tasks-active-context") }));
}
