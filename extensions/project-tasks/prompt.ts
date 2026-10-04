import type { Board, Task } from "./domain.ts";

export function buildBuilderPrompt(board: Board, task: Task): string {
  const plan = board.plans.find((p) => p.id === task.planId);
  const deps = task.dependencies
    .map((id) => board.tasks.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => `- ${t!.id}: ${t!.title} [${t!.status}]${t!.completionSummary ? ` — ${t!.completionSummary}` : ""}`)
    .join("\n") || "- none";
  const files = task.relevantFiles.length ? task.relevantFiles.map((f) => `- ${f}`).join("\n") : "- none specified";
  const acceptance = task.acceptanceCriteria.length ? task.acceptanceCriteria.map((a) => `- ${a}`).join("\n") : "- no explicit acceptance criteria; satisfy the task description";
  return `[PROJECT TASK CLAIMED]\nYou are Builder for ${task.id}. Inspect the current repository state before editing. Stay within this task's scope. Run relevant checks when practical. When finished, call project_tasks.complete with a completion summary and verification evidence, or project_tasks.block with a clear reason. If you stop working without completion, call project_tasks.release.\n\nPlan: ${plan?.title ?? task.planId}\nTask: ${task.title}\nPriority: ${task.priority}\n\nDescription:\n${task.description || "(none)"}\n\nRelevant files:\n${files}\n\nDependencies:\n${deps}\n\nAcceptance criteria:\n${acceptance}`;
}

export function activeTaskContext(board: Board, task: Task): string {
  const plan = board.plans.find((p) => p.id === task.planId);
  return `[ACTIVE PROJECT TASK]\n${task.id} [${task.status}] ${task.title}\nPlan: ${plan?.title ?? task.planId}\nRemember to complete, block, or release this task explicitly with project_tasks.`;
}
