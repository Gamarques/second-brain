# Known bugs (found, not yet fixed)

Found while building the regression baseline on Windows + Node 26. They are listed in
`tools/test-baseline.json` so they do not mask new failures. Fix them, then run
`npm run test:baseline` to drop them from the known list.

| # | Where | Symptom | Probable cause |
|---|-------|---------|----------------|
| 1 | `apps/server/test/admin-deployment.test.ts` (generates a missing configuration encryption key) | `expected 438 to be 384` | Test asserts POSIX file mode `0600`; Windows reports `0666`. |
| 2 | `apps/server/test/admin-main.test.ts` (safe local defaults) | `assetsDirectory` is `C:\workspace\admin-ui`, expected `/workspace/admin-ui` | Test hardcodes POSIX paths; `path.resolve` is OS-specific. |
| 3 | `apps/server/test/release-artifact.test.ts` (deterministic source archive) | `leak-claude-state` entries not excluded | Archive exclusion likely compares POSIX-style paths; may also be affected by local `.claude/` dir. |
| 4 | `apps/admin` tests on Node >= 25 | `localStorage.clear` undefined (116 failures) | Node's experimental global `localStorage` shadows jsdom's. `tools/test.mjs` works around it with `--no-experimental-webstorage`; plain `npx vitest` in `apps/admin` still fails. Use Node 22 (the project's declared engine) or the runner. |
