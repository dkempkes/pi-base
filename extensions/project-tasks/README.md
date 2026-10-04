# Project Tasks Pi Extension

Repository-scoped task board for Planner/Builder handoff.

## Workflow

1. Planner window: `/mode planner`
2. Ask for a plan and say: “save it as project tasks”. Planner should use `project_tasks.create_plan`.
3. Builder window: `/tasks`
4. Select and confirm a ready task.
5. Builder completes, blocks, or releases it with `project_tasks`.

## Storage

- Durable board: `<repo>/.pi/tasks.json` (human-reviewable and normally committed)
- Local coordination: Git metadata directory
  - `pi-project-tasks-state.json`
  - `pi-project-tasks.lock`
  - `pi-project-tasks.backup.json`

Claim ownership, PIDs, host names, session identifiers, backups and locks stay out of Git-trackable task content.

## Commands

- `/tasks` — choose a filter and task, including **Waiting on dependencies**
- `/tasks waiting` — browse todo tasks with unfinished prerequisites (also available as tool list filter `waiting`)

Waiting is a calculated category, not a stored status. Entries show `[waiting on T-0001, ...]` in both the picker and tool lists. Only `done` prerequisites satisfy dependencies; cancelled prerequisites still require resolution. Once all prerequisites are done, an unclaimed todo task appears under Ready automatically. Explicitly blocked tasks remain in Blocked. Selecting a waiting task displays its details without offering to start it.
- `/tasks show T-0001` — show details
- `/tasks start T-0001` — claim and send Builder handoff prompt

## Tool actions

`project_tasks` supports `list`, `get`, `create_plan`, `update_task`, `cancel_task`, `claim`, `release`, `block`, `complete`, and `reopen`.

Planner may list/get/create and revise unstarted tasks. Builder may claim/release/block/complete but should not silently rewrite scope or acceptance criteria.

`create_plan` requires explicit prior user approval before it writes tasks. The planner must present the proposed task first and wait for a clear approval such as “yes” or “goedgekeurd”, then call `create_plan` with `approvalConfirmed: true`; there is no second confirmation dialog. It creates exactly one displayed task by default. Multi-step work should be written as subtasks/steps inside that task's description or acceptance criteria. Multiple displayed tasks are only allowed when the user explicitly asks for multiple separate tasks/tickets/issues; in that case pass `allowMultipleTasks: true`.

## Recovery notes

- Malformed or future-schema `.pi/tasks.json` is rejected and not overwritten.
- The previous valid board is kept as `pi-project-tasks.backup.json` under Git metadata.
- Crashed claims are shown to users; takeover requires an explicit `takeover` flag or command confirmation path.
- Git worktrees resolve coordination files to the worktree Git metadata path while the board remains in the worktree root.
- Use `/reload` after changing extension code.

Task content is project input, not shell code, and is never automatically executed.
