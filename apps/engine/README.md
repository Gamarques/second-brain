# Second Brain Invokta engine

This workspace is the independently runnable, framework-shaped Invokta Action
Engine application. It owns the conventional `src/engine.ts` composition
module, public capabilities, domain contracts, PostgreSQL and model-provider
adapters, migrations, direct and MCP HTTP entrypoints, engine tests,
`invokta.mcp.json`, and `invokta.deploy.json`.

The exported `engine` is the real environment-composed engine used by Invokta
catalog checks and development tooling. Executable entrypoints validate startup
configuration and create a supervised runtime that verifies migrations and
provider identity before accepting invocations. Direct and MCP HTTP execution
both converge on `runtime.engine.invoke`.

Run its checks from the repository root:

```sh
npm run check --workspace @second-brain/engine
```

Run the application entrypoints from the repository root:

```sh
npm run direct
npm run mcp:http
npm run db:migrate
```
