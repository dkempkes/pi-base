# Builder handoff plan: project-scoped task board for Pi

Implemented as a user-wide Pi extension under `C:/Users/Robertus/.pi/agent/extensions/project-tasks/`.

## Assumptions

- The extension is installed user-wide under `C:/Users/Robertus/.pi/agent/extensions/`.
- Each repository stores its durable task board at `.pi/tasks.json`.
- `.pi/tasks.json` is intentionally Git-trackable.
- Selecting Start in Builder claims the task, confirms with the user, and starts an agent turn.
- Planner may write task metadata through the dedicated tool, but may not modify implementation files.

## Current constraints

- `work-mode.ts` only changes available tools; separate Pi windows do not share session state.
- Pi’s example `todo.ts` stores todos in session entries, so it cannot provide cross-window handoff.
- Shared tasks therefore use external project storage, as recommended by Pi’s extension state documentation.
- Do not modify examples under the NVM-installed Pi package; use them only as references.

## Implementation summary

- Created the `project-tasks` extension package with domain, repository, UI, prompt, README, package files, lockfile, and tests.
- Registered the `project_tasks` model tool and `/tasks` command.
- Durable board is `<repo>/.pi/tasks.json`; local claims/locks/backups are under Git metadata.
- Repository scope resolves from `ctx.cwd` to normal Git repositories or worktrees.
- Board schema is versioned, validated, human-reviewable, and deterministically serialized.
- Mutations are serialized with an inter-process lock, stale-lock recovery, backup retention, and atomic rename writes.
- Implemented explicit task transitions and optimistic task versions.
- Integrated with `work-mode.ts` through `work-mode:query`; Planner keeps `project_tasks` active while write/shell tools remain disabled.
- `/tasks` reloads from disk, filters tasks, confirms start, claims atomically, stores session-local active-task binding, and sends a Builder prompt.
- Active task context is reconstructed from session entries and reloaded from disk before Builder turns.
- Project `.pi` watcher refreshes status only.
- Added `.gitignore` entry for `/.pi/.tasks-*.tmp` while leaving `.pi/tasks.json` trackable.

## Validation

From `C:/Users/Robertus/.pi/agent/extensions/project-tasks`:

- `npm run typecheck`
- `npm test`
- `node --import tsx -e "import('./index.ts').then(()=>console.log('import ok'))"`
