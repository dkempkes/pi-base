import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Board, Task, formatTaskLine, readyTasks, unfinishedDependencies, waitingTasks } from "./domain.ts";

export type Filter = "ready" | "waiting" | "in_progress" | "blocked" | "completed" | "all";

export function filterTasks(board: Board, filter: Filter, claims: Record<string, unknown>): Task[] {
  if (filter === "ready") return readyTasks(board, claims as any);
  if (filter === "waiting") return waitingTasks(board);
  if (filter === "in_progress") return board.tasks.filter((t) => t.status === "in_progress");
  if (filter === "blocked") return board.tasks.filter((t) => t.status === "blocked");
  if (filter === "completed") return board.tasks.filter((t) => t.status === "done" || t.status === "cancelled");
  return board.tasks;
}

export function taskDetails(board: Board, task: Task, claim?: any): string {
  const plan = board.plans.find((p) => p.id === task.planId);
  const deps = task.dependencies.length ? task.dependencies.join(", ") : "none";
  const pending = unfinishedDependencies(task, board);
  const waiting = task.status === "todo" && pending.length ? `\nWaiting on: ${pending.join(", ")}` : "";
  const files = task.relevantFiles.length ? task.relevantFiles.join("\n- ") : "none";
  const criteria = task.acceptanceCriteria.length ? task.acceptanceCriteria.join("\n- ") : "none";
  const owner = claim ? `\nClaim: ${claim.hostname}/${claim.pid} ${claim.sessionName ?? claim.sessionId ?? ""} at ${claim.claimedAt}` : "";
  return `${task.id} [${task.status}] ${task.title}\nPlan: ${plan?.title ?? task.planId}\nPriority: ${task.priority}${owner}\n\nDescription:\n${task.description || "(none)"}\n\nDependencies: ${deps}${waiting}\n\nRelevant files:\n- ${files}\n\nAcceptance criteria:\n- ${criteria}`;
}

export async function selectFilter(ctx: ExtensionCommandContext): Promise<Filter | undefined> {
  const filters: { label: string; value: Filter }[] = [
    { label: "Ready", value: "ready" },
    { label: "Waiting on dependencies", value: "waiting" },
    { label: "In progress", value: "in_progress" },
    { label: "Blocked", value: "blocked" },
    { label: "Completed", value: "completed" },
    { label: "All", value: "all" },
  ];
  const choice = await ctx.ui.select("Project tasks", filters.map((f) => f.label));
  return filters.find((f) => f.label === choice)?.value;
}

export async function selectTask(ctx: ExtensionCommandContext, board: Board, tasks: Task[]): Promise<Task | undefined> {
  if (!tasks.length) {
    ctx.ui.notify("No tasks match that filter", "info");
    return undefined;
  }
  const labels = tasks.map((t) => formatTaskLine(t, board.plans.find((p) => p.id === t.planId), board));
  const selected = await ctx.ui.select("Select task", labels);
  if (!selected) return undefined;
  const id = selected.split(" ")[0];
  return tasks.find((t) => t.id === id);
}
