/** Response helpers shared by the admin API transports. */
export const apiSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...apiSecurityHeaders, "content-type": "application/json; charset=utf-8" },
  });
}
