# Agent Instructions

## Scope

This repository is a dedicated Pi workspace for extensions, skills, prompts, themes, configuration experiments, and resumable sessions. Keep unrelated project rules and domain knowledge out of this repository.

## Workflow

1. Read `docs/PI_KNOWLEDGEBASE.md` completely before planning or making changes.
2. Inspect relevant files and the installed Pi documentation before changing Pi features. Documentation is located at `C:/Users/Robertus/AppData/Local/nvm/v22.23.1/node_modules/@earendil-works/pi-coding-agent/docs`.
3. Make the smallest focused change that satisfies the request. Follow existing conventions and avoid unrelated edits.
4. Validate changes with relevant checks when available. Clearly report anything not tested.
5. Record reusable Pi findings and decisions in `docs/PI_KNOWLEDGEBASE.md`.

## Safety and Coordination

- Preserve existing user changes. Ask before destructive operations.
- Never commit credentials, tokens, or other secrets.
- Use `project_tasks` to manage tasks; do not edit `.pi/tasks.json` directly.
- Obtain explicit user approval before saving a task plan. Create one task per request unless the user explicitly requests multiple tasks; keep steps inside that task.
- In planner mode, only inspect and create planning metadata; do not claim or complete tasks.

## Communication

Keep responses concise, identify changed file paths, and summarize validation results or remaining limitations.
