# Pi Base

Dedicated workspace for Pi sessions, extensions, skills, prompt templates, themes, and Pi-specific knowledge.

Start with:

```bash
just pi
```

Resume previous work with:

```bash
just resume
```

Project knowledge is in `docs/PI_KNOWLEDGEBASE.md`.

## Portable extensions

`extensions/` contains the personal extensions copied from the global Pi directory:

- `done-sound.ts` — completion sound and DONE indicator.
- `git-branch-status.ts` — Git branch and custom footer status.
- `project-tasks/` — repository task board, including its source and tests.
- `work-mode.ts` — Planner/Builder work modes.

The root `package.json` exposes these as a Pi package. They are deliberately outside `.pi/extensions/` so cloning this workspace does not automatically load a second copy alongside existing global extensions.

### Use on another computer

Install Pi, clone this repository, then run from the clone:

```bash
pi install .
```

This registers the local package globally, so the extensions are available in all projects. Keep the clone in place. After pulling updates, restart Pi or run `/reload`.

Alternatively, after publishing to GitHub, install directly (replace OWNER and REPO):

```bash
pi install git:github.com/OWNER/REPO
```

Update a Git-installed copy with `pi update --extensions`, then restart or `/reload`. Do not install both the local and Git sources at once.

### Existing computers: avoid duplicate loading

Before installing this package on a computer with the original global extensions, move the matching files and the `project-tasks` directory out of `~/.pi/agent/extensions/` into a backup directory outside that auto-discovery directory. Alternatively, disable the original resources with `pi config`. Then install the package and restart Pi.

The copy operation did not change or remove the originals. Make future extension edits in this repository, not in the old global copies.

### Git safety and testing

Extension source, tests, and package metadata are included; `node_modules/`, local sessions, and `.env` secrets are ignored. Review files before committing, especially any existing workspace configuration. Global credentials and authentication settings were not copied.

To run the task extension's checks:

```bash
cd extensions/project-tasks
npm ci
npm test
npm run typecheck
```

Pi supplies the extensions' runtime imports; dependency installation is only needed for standalone development checks.
