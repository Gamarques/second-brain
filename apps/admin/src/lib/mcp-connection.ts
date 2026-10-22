/**
 * Pure connection-detail builder for the "Connect a client" screen. Kept
 * decoupled from `window.location` and React so it is cheaply unit tested;
 * the route component supplies the browser's own origin.
 *
 * Grounding for every value below:
 * - the MCP endpoint is `${origin}/mcp` — README.md "MCP HTTP and client
 *   continuity" states "The production endpoint is
 *   `${SECOND_BRAIN_PUBLIC_URL}/mcp`", and `compose.yaml` routes `/mcp` to
 *   the `engine` service on the same public host the admin console itself
 *   is served from (`admin` handles `/admin` and `/api/admin` on that same
 *   host), so the browser's own origin is always correct — no server
 *   endpoint has to report it.
 * - `mcpServerId` matches this repository's own MCP manifest
 *   (`invokta.mcp.json`, top-level `"id": "second-brain"`).
 * - the `mcpServers` JSON block with a `"type": "http"` entry is the
 *   configuration shape generic MCP clients such as project `.mcp.json`
 *   files read for an HTTP server. Claude's remote connector flow does not
 *   use this block.
 * - `claude mcp add --transport http <name> <url>` is Claude Code's
 *   documented CLI syntax for adding a Streamable HTTP server
 *   (`claude mcp add --help`).
 * - `codex mcp add <name> --url <url>` and the resulting
 *   `[mcp_servers.<name>]` / `url = "..."` block in `~/.codex/config.toml`
 *   were confirmed by actually running the local `codex` CLI (`codex mcp
 *   add --help`, then a real add/inspect/remove cycle against
 *   `~/.codex/config.toml`, restored byte-for-byte afterward) — not
 *   recalled from memory. `codex mcp login <name>` is Codex's documented
 *   follow-up to complete an OAuth sign-in for a server that requires one.
 * - the Replit install link's shape — `https://replit.com/integrations?mcp=`
 *   followed by a base64-encoded (then percent-encoded for the query
 *   string) `{"displayName","baseUrl"}` JSON payload, with OAuth walked
 *   through automatically once the server is added — is Replit's own
 *   documented "Add a custom MCP server" mechanism
 *   (docs.replit.com/build/connect-via-mcp#add-a-custom-mcp-server).
 * - ChatGPT's Developer Mode connector flow is UI-only (Settings →
 *   Connectors/Apps → Advanced settings → Developer mode → add a
 *   connector with a URL and OAuth authentication) — OpenAI's help center
 *   article on "Developer mode and MCP apps in ChatGPT" and independent
 *   walkthroughs agree it never involves a config file, so this deployment
 *   offers only the server URL for it, not a fabricated JSON/command.
 *
 * Nothing here ever includes a token, bearer credential, or secret: this
 * deployment's MCP endpoint authenticates with OAuth (`http-auth.ts`), and
 * a compliant client discovers and completes that sign-in itself once it
 * has the URL below. See `mcp-connection.test.ts` for a standing assertion
 * that no credential-shaped value sneaks into these strings.
 */
export const mcpServerId = "second-brain";

export interface McpConnectionDetails {
  readonly serverUrl: string;
  readonly configJson: string;
  readonly claudeCodeCommand: string;
  readonly codexAddCommand: string;
  readonly codexLoginCommand: string;
  readonly codexConfigToml: string;
  readonly replitInstallUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildReplitInstallUrl(serverUrl: string): string {
  // Only a display name and this deployment's own MCP URL travel in the
  // payload — never a header or token. Replit walks the user through OAuth
  // itself once it has connected (see the module doc for the source).
  const payload = JSON.stringify({ displayName: mcpServerId, baseUrl: serverUrl });
  return `https://replit.com/integrations?mcp=${encodeURIComponent(btoa(payload))}`;
}

export function buildMcpConnectionDetails(origin: string): McpConnectionDetails {
  const serverUrl = `${trimTrailingSlash(origin)}/mcp`;
  const configJson = JSON.stringify(
    { mcpServers: { [mcpServerId]: { type: "http", url: serverUrl } } },
    null,
    2,
  );
  const claudeCodeCommand = `claude mcp add --transport http ${mcpServerId} ${serverUrl}`;
  const codexAddCommand = `codex mcp add ${mcpServerId} --url ${serverUrl}`;
  const codexLoginCommand = `codex mcp login ${mcpServerId}`;
  const codexConfigToml = `[mcp_servers.${mcpServerId}]\nurl = "${serverUrl}"`;
  const replitInstallUrl = buildReplitInstallUrl(serverUrl);
  return {
    serverUrl,
    configJson,
    claudeCodeCommand,
    codexAddCommand,
    codexLoginCommand,
    codexConfigToml,
    replitInstallUrl,
  };
}

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Hostnames and address ranges that ChatGPT's and Replit's cloud
 * infrastructure can never reach: the IPv4/IPv6 loopback range (matching
 * `http-auth.ts`'s own loopback set), RFC 1918 / RFC 4193 / RFC 3927
 * private and link-local ranges, and mDNS `.local` names.
 */
function isLoopbackOrPrivateHostname(hostname: string): boolean {
  if (loopbackHostnames.has(hostname)) return true;
  if (hostname.endsWith(".local")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (ipv4 !== null) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 127) return true; // 127.0.0.0/8 loopback
    if (first === 10) return true; // 10.0.0.0/8 private
    if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12 private
    if (first === 192 && second === 168) return true; // 192.168.0.0/16 private
    if (first === 169 && second === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    if (address.startsWith("fe80:")) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7 unique-local
    return false;
  }

  return false;
}

/**
 * True only for an origin a cloud-hosted MCP client (ChatGPT, Replit) can
 * actually reach: a public hostname over HTTPS. `http-auth.ts` accepts
 * plain HTTP on loopback for local development, but nothing outside this
 * machine can dial that address, so it's excluded here too.
 */
export function isPubliclyReachableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackOrPrivateHostname(url.hostname.toLowerCase())) return false;
  return url.protocol === "https:";
}

export type ConnectClientId = "chatgpt" | "claudeDesktop" | "claudeCode" | "codex" | "replit";

/**
 * Cloud-hosted apps (ChatGPT, Claude Connectors, Replit) can only reach a
 * public HTTPS origin. On a computer-only address, Claude Code is the
 * path that actually works.
 */
export function connectClientOrder(reachable: boolean): ConnectClientId[] {
  return reachable
    ? ["chatgpt", "claudeDesktop", "claudeCode", "codex", "replit"]
    : ["claudeCode", "claudeDesktop", "chatgpt", "codex", "replit"];
}

export function defaultConnectClient(reachable: boolean): ConnectClientId {
  return connectClientOrder(reachable)[0] ?? "claudeCode";
}
