import "./env.js";

import { reportStartupFailure } from "./env.js";
import { localPrincipal } from "./local-principal.js";
import { createSecondBrainRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const principal = localPrincipal();
  const runtime = await createSecondBrainRuntime();
  try {
    const result = await runtime.engine.invoke(
      "tasks_list",
      {},
      { source: "direct", principal },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch(reportStartupFailure);
