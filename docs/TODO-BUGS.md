# TODO-BUGS

## Open

(none)

## Done

### TODO-001: admin deployment test asserts POSIX file mode 0600 on Windows
- Found: 2026-10-22 by regression baseline run (Windows 11, Node 26.7), `apps/server/test/admin-deployment.test.ts` ("generates a missing configuration encryption key before Compose interpolates it")
- Evidence: `AssertionError: expected 438 to be 384` (438 = 0o666, 384 = 0o600; Windows has no POSIX modes)
- Expected / acceptance criteria:
  - The mode assertion is skipped or adapted only on `win32` (still enforced on POSIX); the key-generation behaviour stays asserted everywhere.
  - `cd apps/server && npx vitest run test/admin-deployment.test.ts` passes on Windows.
  - Production code (`deploy/deploy.sh`) is not weakened.
- Severity: low
- Status: done (Jev 3.83, 2026-10-22)

### TODO-002: admin server config test hardcodes POSIX paths
- Found: 2026-10-22 by regression baseline run, `apps/server/test/admin-main.test.ts` ("uses safe local defaults and accepts explicit deployment values")
- Evidence: `assetsDirectory` received `C:\workspace\admin-ui`, expected `/workspace/admin-ui` (`readAdminServerConfiguration({}, "/workspace")`)
- Expected / acceptance criteria:
  - Expected values are built with `path.resolve`/`path.join` (or the test is otherwise OS-independent) without changing `readAdminServerConfiguration` behaviour on POSIX.
  - `cd apps/server && npx vitest run test/admin-main.test.ts` passes on Windows.
- Severity: low
- Status: done (Jev 3.80, 2026-10-22)

### TODO-003: release source archive includes secret-looking files on Windows
- Found: 2026-10-22 by regression baseline run, `apps/server/test/release-artifact.test.ts:364` ("builds a deterministic source archive with a security-conscious layout")
- Evidence: archive entry names contain `leak-claude-state`, `leak-env`, `leak-service-account` (fixtures that must be excluded). Likely cause: exclusion rules in `apps/server/src/release/artifact.ts` compare POSIX-style paths/separators.
- Expected / acceptance criteria:
  - Root cause identified; the exclusion works on Windows AND POSIX (this is a security control: `.env`, service accounts and Claude state must never ship in a release archive).
  - `cd apps/server && npx vitest run test/release-artifact.test.ts` passes on Windows; test is not weakened (the forbidden-names assertion stays).
  - No change that makes the archive non-deterministic.
- Severity: low (was high; premise disproved)
- Status: done (Jev 3.68 after 3 rounds, 2026-10-22)
- Resolution: root cause was the Windows-only test fixture (`ln -s` copies files under Git Bash), NOT the archive builder; real Windows release builds were never affected. Fixture now stages mode 120000 symlinks in the git index. Mutation check (disabling the symlink exclusion) makes the test fail with the original leak names; PR #1 CI on ubuntu/Node 22 passes. Severity downgraded to low.

### TODO-004: admin tests fail on Node >= 25 (global localStorage shadows jsdom)
- Found: 2026-10-22 by `npx vitest run` in `apps/admin` on Node 26.7
- Evidence: 116 failures, `TypeError: Cannot read properties of undefined (reading 'clear')`; passes with `NODE_OPTIONS=--no-experimental-webstorage`.
- Expected / acceptance criteria:
  - `cd apps/admin && npx vitest run` (no env var) passes on Node 26 — e.g. a setup-file/vitest config fix — without breaking Node 22.
  - `tools/test.mjs` workaround can then be removed or left harmless.
- Severity: medium
- Status: done (Jev 3.31 after 2 rounds, 2026-10-22)
