/** Browser client metadata owned by the OAuth service. */
import type { ClientMetadata } from "oidc-provider";

export const adminOAuthClientId = "second-brain-admin";
export const adminOAuthScope = "admin:panel";
export const adminOAuthCallbackPath = "/admin/oauth/callback";
export const adminOAuthLoginPath = "/admin/login";
export const adminOAuthResourcePath = "/api/admin";

export function adminOAuthResource(origin: string): string {
  return new URL(adminOAuthResourcePath, `${origin}/`).href.replace(/\/$/u, "");
}

/** Static OAuth 2.1 public client for the same-origin browser application. */
export function adminOAuthClient(origin: string): ClientMetadata {
  return {
    client_id: adminOAuthClientId,
    client_name: "Second Brain Admin",
    application_type: "web",
    redirect_uris: [new URL(adminOAuthCallbackPath, `${origin}/`).href],
    post_logout_redirect_uris: [new URL(adminOAuthLoginPath, `${origin}/`).href],
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    id_token_signed_response_alg: "ES256",
  };
}
