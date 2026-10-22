# Regression suite

Everything that existed at 1.4.0 is the frozen baseline. When you add a feature, write tests only
for the new code; the runner tells you if anything old broke.

| Command | What it does |
|---|---|
| `npm run test:regression` | Full unit suite (engine, server, admin). Fails only on failures **not** listed in `tools/test-baseline.json`. |
| `npm run test:changed` | Only tests affected by uncommitted changes (`vitest --changed`). Use while developing. |
| `node tools/test.mjs --changed=main` | Only tests affected since a git ref (use in a feature branch / PR). |
| `node tools/test.mjs --only=engine,admin` | Limit to some workspaces. |
| `npm run test:baseline` | Re-record the known failures (after fixing one, or accepting a new one on purpose). |
| `npm run test:postgres` | Real-database suite (needs Docker). Not part of the runner. |

## Frozen contracts

`apps/engine/test/contract/baseline-contract.test.ts` protects the released surface:

- every capability id in `test/contract/baseline/capabilities.json` must still be in `invokta.mcp.json`
  (new ids are fine, removing or renaming one fails);
- every migration in `test/contract/baseline/migrations.json` must be byte-identical (new migrations are fine).

Accepting a deliberate breaking change means editing those JSON files in the same commit.

## Feature workflow

1. Branch, implement, add tests next to the new code.
2. `npm run test:changed` while iterating.
3. Before merging: `npm run test:regression` must report `0 NEW failure(s)`.
4. If you added capabilities, append them to `baseline/capabilities.json` once released.

Known failing tests (currently none) are tracked in `docs/TODO-BUGS.md`.
