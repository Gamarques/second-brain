/** Self-hosted OAuth 2.1 authorization server composition root. */
import "@second-brain/engine/env";

import { createServer, type IncomingMessage } from "node:http";

import { createDatabaseRuntime } from "@second-brain/engine/database/client";
import { requireDatabaseConfiguration } from "@second-brain/engine/database/config";
import { assertMigrationsCurrent } from "@second-brain/engine/database/migrate";
import { DrizzleAdminAuditStore } from "../shared/audit-store.js";
import { reportStartupFailure } from "@second-brain/engine/env";
import { adminOAuthClientId } from "./admin-client.js";
import {
  formatOAuthRequestCompletion,
  formatOAuthRequestFailure,
  oauthDiagnosticRoute,
} from "./diagnostics.js";
import { createInteractionHandler } from "./interaction-server.js";
import {
  createOAuthProvider,
  formatOAuthRegistrationError,
} from "./provider.js";
import { readOAuthServerConfiguration } from "./server-config.js";

function requestHostname(request: IncomingMessage): string | null {
  const hostValues = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
  );
  if (hostValues.length !== 1 || request.headers.host === undefined) return null;
  try {
    return new URL(`http://${request.headers.host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  requireDatabaseConfiguration();
  const configuration = readOAuthServerConfiguration();
  const databaseRuntime = createDatabaseRuntime();
  let composition: Awaited<ReturnType<typeof createOAuthProvider>>;
  try {
    await assertMigrationsCurrent(databaseRuntime.pool);
    composition = await createOAuthProvider(
      databaseRuntime.database,
      configuration,
    );
  } catch (error) {
    await databaseRuntime.close();
    throw error;
  }
  composition.provider.on("registration_create.error", (context, error) => {
    process.stderr.write(
      formatOAuthRegistrationError(
        { method: context.method, path: context.path },
        error,
      ),
    );
  });
  const audit = new DrizzleAdminAuditStore(databaseRuntime.database);
  const handleInteraction = createInteractionHandler({
    ...composition,
    loginAudit: {
      clientId: adminOAuthClientId,
      record(event, signal) {
        return audit.recordOAuthSignInOutcome(event, signal);
      },
    },
  });
  const handleOidc = composition.provider.callback();
  const allowedHosts = new Set(configuration.allowedHosts);

  const server = createServer((request, response) => {
    let requestPath: string | undefined;
    void (async () => {
      const hostname = requestHostname(request);
      if (hostname === null || !allowedHosts.has(hostname)) {
        response.statusCode = 403;
        response.end("Forbidden.");
        return;
      }
      let path: string;
      try {
        path = new URL(request.url ?? "/", configuration.issuer).pathname;
      } catch {
        response.statusCode = 400;
        response.end("Invalid request target.");
        return;
      }
      requestPath = path;
      if (oauthDiagnosticRoute(path) !== null) {
        response.once("finish", () => {
          process.stderr.write(
            formatOAuthRequestCompletion({
              issuer: configuration.issuer,
              location: response.getHeader("location"),
              method: request.method,
              path,
              status: response.statusCode,
            }),
          );
        });
      }
      if (await handleInteraction(request, response, path)) return;
      handleOidc(request, response);
    })().catch((error: unknown) => {
      process.stderr.write(
        formatOAuthRequestFailure(
          { method: request.method, path: requestPath },
          error,
        ),
      );
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
      }
      if (!response.writableEnded) {
        response.end('{"error":"server_error"}');
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuration.port, configuration.host, () => resolve());
    });
  } catch (error) {
    await databaseRuntime.close();
    throw error;
  }

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => {
      databaseRuntime.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stderr.write(
    `OAuth issuer: ${configuration.issuer} (listening on ${configuration.host}:${configuration.port})\n`,
  );
}

main().catch(reportStartupFailure);
