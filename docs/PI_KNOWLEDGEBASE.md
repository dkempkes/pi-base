# Pi Project Knowledgebase

This workspace is for Pi-related work only: local sessions, extensions, skills, prompt templates, themes, SDK experiments, and notes about Pi usage.

## Layout

- `justfile` - convenient Pi launch/resume/planner/builder recipes.
- `.pi/settings.json` - project-local Pi settings. It sets `sessionDir` to `.pi/session-data`.
- `.pi/session-data/` - saved Pi session JSONL files for this workspace.
- `.pi/extensions/` - project-local Pi extensions.
- `extensions/` - version-controlled copies of personal extensions, exposed by the root `package.json` as a portable Pi package.
- `.pi/skills/` - project-local Pi skills.
- `.pi/prompts/` - project-local prompt templates.
- `.pi/themes/` - project-local themes.
- `docs/PI_KNOWLEDGEBASE.md` - this Pi-specific knowledgebase.

## Sessions

Pi saves sessions automatically unless started with `--no-session`. This project stores sessions in `.pi/session-data` via both `.pi/settings.json` and the `justfile` `--session-dir` flag.

Useful commands:

- `just pi` - open Pi in this workspace.
- `just resume` - open the session picker.
- `just continue` - continue the newest workspace session.
- `just named "name"` - start a new named session.
- `just sessions` - list saved session files newest first.

Inside Pi:

- `/resume` opens the session picker.
- `/new` starts a fresh session.
- `/name` renames the current session.
- `/session` shows the current session file and usage.
- `/tree`, `/fork`, and `/clone` manage branches and alternatives.

## Extension development notes

- User-wide extensions live under `C:/Users/Robertus/.pi/agent/extensions/`; multi-file extensions can be directories with `index.ts`.
- The user-wide `project-tasks` extension provides a repository-scoped task board, local coordination files under Git metadata, a `project_tasks` model tool, and a `/tasks` command. Its default provider remains `.pi/tasks.json`. A repository can instead add `.pi/project-tasks.json` with provider `planka`, a non-secret URL/project/board selection and an API-key environment variable or local secret file. In PLANKA mode the online board is authoritative and the extension never falls back to the JSON board after a network error. Task IDs and idempotency metadata live in hidden card-description markers; fixed Dutch list names map task status. Agent writes are sequential, status changes patch only list/position, completion details are comments, and planner text updates reject stale versions. PLANKA 2.2.1 has no atomic conditional card update, so the extension detects known stale state but cannot eliminate the final request race. In either provider it queries `work-mode.ts` through `work-mode:query`. `create_plan` requires explicit prior user approval through `approvalConfirmed: true`, creates one displayed task by default, and allows several only after an explicit user request with `allowMultipleTasks: true`.
- The user-wide `done-sound.ts` extension plays a generated WAV chime on Windows (terminal bell elsewhere) after a successfully settled agent run and sets status key `zz-done-indicator` to a green `DONE`. Windows playback is awaited and spawn/playback failures surface as UI warnings rather than being silently ignored. `/done-sound` tests playback independently of agent completion; use `/reload` or restart Pi after changing the extension. Successful playback does not prove audibility: also check the Windows output device and PowerShell volume mixer if no warning appears. The user-wide `git-branch-status.ts` footer treats that key specially and right-aligns it on the same footer status line as tasks.
- Project extensions live in `.pi/extensions/` and load after project trust is granted.
- A simple extension can be a single `.ts` file exporting a default factory that receives `ExtensionAPI`.
- During development, an extension can also be loaded explicitly with `pi --extension ./path/to/file.ts`.
- Extensions run with local OS permissions; review code before loading it.
- Prefer Pi's documented APIs and examples. Read the installed docs before implementing new extension capabilities.

## Documentation source

Installed Pi docs are under:

`C:/Users/Robertus/AppData/Local/nvm/v22.23.1/node_modules/@earendil-works/pi-coding-agent/docs`

The most relevant docs for this workspace are `configuration.md`, `sessions.md`, `extensions.md`, `skills.md`, `prompt-templates.md`, `themes.md`, `tui.md`, `sdk.md`, and `packages.md`.

## Portable personal extension package

- The four personal extensions (`done-sound`, `git-branch-status`, `project-tasks`, and `work-mode`) were copied into `extensions/`, including task tests and development metadata, without copying `node_modules` or global credentials. Original global files were subsequently moved outside auto-discovery to `C:/Users/Robertus/.pi/agent/extensions-backup-20261002-192542/` to resolve duplicate tool/flag registration. The global `extensions/` directory is now empty; restart Pi to load only the registered repository package.
- Install this repository globally with `pi install .` from a clone, or `pi install git:github.com/OWNER/REPO` after publication. A local install loads from the clone; Git installs maintain a separate checkout.
- Keep portable resources outside `.pi/extensions/` to avoid automatic duplicate loading in this workspace. Before installing the package on an existing machine, disable originals with `pi config` or move them outside the global discovery directory. Do not install both local and Git versions.
- Host-provided imports belong in `peerDependencies`, not runtime `dependencies`. Pi provides them when loading extensions; standalone development checks can install peers with npm.
- `node_modules/`, `.pi/session-data/`, and `.env` files are ignored for Git. Review other existing configuration before publication.

## Task dependency browsing

- `/tasks` includes a calculated **Waiting on dependencies** category (`/tasks waiting`, tool list filter `waiting`) for todo tasks with prerequisites not yet `done`. Cancelled prerequisites do not count as completed.
- Task picker and tool list entries show unfinished prerequisite IDs; details also identify what the task is waiting on. Explicit Blocked stays separate, and no stored status/schema changes are needed. Once prerequisites finish, unclaimed todo tasks automatically become Ready. Browsing non-ready tasks displays details without a start confirmation.

## Maintenance rule

When a Pi-specific convention, reusable implementation pattern, or important decision is discovered, add it here so future sessions can pick it up quickly.
