/** HTTP-only security policy owned by the browser administration service. */
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class AdminHttpSecurityError extends Error {
  constructor(
    readonly status: 400 | 403 | 405 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminHttpSecurityError";
  }
}

function forbidden(code: string, message: string): never {
  throw new AdminHttpSecurityError(403, code, message);
}

/** Exact-origin and fetch-metadata checks shared by every browser mutation. */
export function requireTrustedOrigin(request: Request, trustedOrigin: string): void {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new AdminHttpSecurityError(
      400,
      "ADMIN_TARGET_INVALID",
      "Admin request target is invalid.",
    );
  }
  if (
    requestOrigin !== trustedOrigin ||
    request.headers.get("origin") !== trustedOrigin
  ) {
    forbidden("ADMIN_ORIGIN_DENIED", "Admin request origin was denied.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    forbidden("ADMIN_FETCH_SITE_DENIED", "Admin request origin was denied.");
  }
}

function requireTrustedJsonRequest(request: Request, trustedOrigin: string): void {
  requireTrustedOrigin(request, trustedOrigin);

  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)
  ) {
    throw new AdminHttpSecurityError(
      415,
      "ADMIN_CONTENT_TYPE_DENIED",
      "Admin mutations require application/json.",
    );
  }
}

/**
 * The one route family that carries bytes instead of JSON: a Brain Pack upload.
 * Everything else keeps the JSON-only rule above.
 */
export function requireAdminBinaryMutationSecurity(
  request: Request,
  trustedOrigin: string,
): void {
  if (request.method !== "POST") {
    throw new AdminHttpSecurityError(
      405,
      "ADMIN_METHOD_DENIED",
      "Brain Pack uploads require POST.",
    );
  }
  requireTrustedOrigin(request, trustedOrigin);
  const contentType = request.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim();
  if (contentType !== "application/octet-stream") {
    throw new AdminHttpSecurityError(
      415,
      "ADMIN_CONTENT_TYPE_DENIED",
      "Brain Pack uploads require application/octet-stream.",
    );
  }
}

export function requireAdminMutationSecurity(
  request: Request,
  trustedOrigin: string,
): void {
  if (!mutationMethods.has(request.method)) {
    throw new AdminHttpSecurityError(
      405,
      "ADMIN_METHOD_DENIED",
      "Admin mutations require POST, PUT, PATCH, or DELETE.",
    );
  }

  requireTrustedJsonRequest(request, trustedOrigin);
}
