---
name: develop-invokta-project
description: Develop this generated Invokta Action Engine when changing capabilities, dependencies, tests, or its trusted direct invocation and MCP HTTP channel. Use for implementation, refactoring, debugging, and contract review in this project.
---

# Develop This Action Engine

## Establish the contract

1. Read `AGENTS.md`, `README.md`, and the existing capability and engine tests.
2. Identify the domain action, public capability ID, input, output, access rule, annotations, timeout, and observable errors affected by the change.
3. Treat capability IDs, schemas, access behavior, and adapter-visible results as compatibility surfaces. Request an explicit decision before breaking one.

## Keep one architecture

- Define domain actions with `defineCapability` and explicit input, output, access, and execution contracts.
- Inject models, providers, repositories, tools, and policy checks through engine-owned factories or closures.
- Register capabilities under literal domain-oriented IDs in
  `apps/engine/src/engine.ts`.
- Keep every execution channel on `engine.invoke`; never call a capability's `run` directly.
- Keep the framework-conventional `engine` export, direct invocation, MCP HTTP
  entrypoint, deployment configuration, and `invokta.mcp.json` catalog in the
  independently runnable `apps/engine/` application.
- Keep business logic out of `apps/engine/src/direct.ts` and
  `apps/engine/src/mcp-http.ts`.
- Do not add a service locator, runtime registry, plugin discovery, workflow engine, or adapter-specific capability implementation.
- Preserve fail-closed authentication in
  `apps/engine/src/http-auth.ts`; never
  add a development bypass.

## Deliver the change

1. Add or update an engine-level test that invokes the capability and fails for the missing behavior.
2. Implement the smallest capability, dependency, composition-root, or adapter wiring change that makes the test pass.
3. Cover invalid input, denied access, output validation, cancellation, or dependency failure when relevant to the contract.
4. Keep trusted direct invocation and MCP HTTP behavior consistent by testing the shared engine boundary rather than duplicating handlers.
5. Update project documentation when commands, configuration, capability IDs, or public behavior change.
6. Run `npm run check` and resolve every type, test, formatting, and build failure before completion.
