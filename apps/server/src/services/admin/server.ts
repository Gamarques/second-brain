/** Static UI and JSON API host owned by the administration service. */
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const documentCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export interface AdminServerDependencies {
  readonly adminHttp: (request: Request) => Promise<Response>;
  readonly assetsDirectory: string;
}

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.startsWith("text/html") === true;
}

/**
 * Composes the OAuth-protected admin API and built Vite SPA on the public
 * origin. Runtime/database construction remains an injected composition-root
 * responsibility; OAuth endpoints stay on the existing authorization server.
 */
export function createAdminServerApp(dependencies: AdminServerDependencies) {
  const app = new Hono();

  app.onError((_error, context) => {
    context.header("Cache-Control", "no-store");
    context.header("Content-Security-Policy", documentCsp);
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    if (context.req.path.startsWith("/api/")) {
      return context.json(
        { error: "ADMIN_REQUEST_FAILED", message: "Admin request failed." },
        500,
      );
    }
    return context.text("Server error.", 500);
  });

  app.use("*", async (context, next) => {
    await next();
    context.header("Content-Security-Policy", documentCsp);
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    context.header("Cross-Origin-Opener-Policy", "same-origin");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    if (context.req.path.startsWith("/api/")) {
      context.header("Cache-Control", "no-store");
      context.header("Pragma", "no-cache");
    } else if (isHtmlResponse(context.res)) {
      context.header("Cache-Control", "no-store");
    }
  });

  app.all("/api/admin/*", (context) => dependencies.adminHttp(context.req.raw));

  app.get("/", (context) => context.redirect("/admin/", 302));
  app.get("/admin", (context) => context.redirect("/admin/", 308));

  app.use(
    "/admin/*",
    serveStatic({
      root: dependencies.assetsDirectory,
      precompressed: true,
      rewriteRequestPath: (path) => path.replace(/^\/admin/u, ""),
      onFound(path, context) {
        if (path !== `${dependencies.assetsDirectory}/index.html`) {
          context.header("Cache-Control", "public, max-age=3600");
        }
      },
    }),
  );
  app.get(
    "/admin/*",
    serveStatic({ root: dependencies.assetsDirectory, path: "index.html" }),
  );

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/")) {
      return context.json({ error: "NOT_FOUND", message: "Not found." }, 404);
    }
    return context.text("Not found.", 404);
  });

  return app;
}

export interface StartAdminServerOptions {
  readonly hostname: string;
  readonly port: number;
}

/** Starts an already-composed app; lifecycle ownership stays with the caller. */
export function startAdminServer(
  app: ReturnType<typeof createAdminServerApp>,
  options: StartAdminServerOptions,
): ServerType {
  return serve({
    fetch: app.fetch,
    hostname: options.hostname,
    port: options.port,
  });
}
