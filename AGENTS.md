# Project Instructions

## Language

Write all project content in English, including documentation, source comments,
public errors, examples, tests, commits, and release notes. Two exceptions:
member-facing guides under `docs/` may ship a Brazilian Portuguese translation
as a sibling `*.pt-BR.md` file that mirrors its English source
heading-for-heading. The English version is always the source of truth; update
it first and keep the translation in the same change.

## Internationalization

- `apps/admin/` ships English, Brazilian Portuguese (`pt-BR`), and Spanish
  (`es`) via `apps/admin/src/lib/i18n/`. `en.ts` is the reference catalog;
  add a new key there first, then mirror it in `pt-BR.ts` and `es.ts` —
  the `Catalog` type makes a missing or mistranslated key a compile error.
- Never hardcode user-facing copy in a component. Add a catalog key and
  read it with `useTranslation()`'s `t(key, params?)`, or `translate()`
  directly in non-hook modules (`lib/navigation.ts`, `lib/utils.ts`,
  `lib/api.ts`) that need a locale-aware string outside a component.
- Use `{param}` interpolation for dynamic values and a `{ one, other }`
  plural object (selected via `Intl.PluralRules`) for counted nouns —
  never a ternary.
- Keep true technical identifiers (IANA zone names, env var names, HTTP/
  OAuth/PKCE/JSON terms) untranslated in every catalog.

## Architecture

- Keep the repository root as an npm-workspaces orchestration layer. The
  independently runnable Invokta application belongs under `apps/engine/`,
  including its capabilities, direct and MCP HTTP entrypoints, persistence,
  providers, migrations, package configuration, and engine-owned tests.
  OAuth, browser-administration API, and automation-worker services belong
  under `apps/server/`; browser administration belongs under `apps/admin/`.
- Declare application dependencies in the owning workspace. The root may own
  tooling shared by multiple workspaces, but no runtime dependencies. Keep one
  root `package-lock.json` and do not add nested lockfiles.
- Define domain actions as capabilities with explicit input, output, access, and execution contracts.
- Keep trusted direct invocation and MCP HTTP on the single `engine.invoke` path.
- Keep models, prompts, providers, data stores, and tools behind replaceable
  engine-owned dependencies.
- Keep business logic out of `apps/engine/src/direct.ts` and
  `apps/engine/src/mcp-http.ts`.
- Do not add framework-wide registries, service locators, or adapter-specific business logic.
- Keep HTTP authentication fail-closed until
  `apps/engine/src/http-auth.ts` verifies a real credential.

## Delivery

- Follow RED, GREEN, REFACTOR for executable behavior.
- Run `npm run check` before completing a change.
- Keep `CLAUDE.md` as a symbolic link to this file so agent instructions have one source of truth.
