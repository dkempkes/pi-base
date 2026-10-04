# Project Pi extensions

Put project-local Pi extensions here. Pi loads `.ts` or `.js` files in this directory after project trust is granted.

Example start command from the repository root:

```bash
just pi
```

For one-off testing of a specific file:

```bash
pi --session-dir .pi/session-data --extension .pi/extensions/my-extension.ts
```
