import { describe, expect, it } from "vitest";

import {
  buildMcpConnectionDetails,
  connectClientOrder,
  defaultConnectClient,
  isPubliclyReachableOrigin,
  mcpServerId,
} from "./mcp-connection";

describe("buildMcpConnectionDetails", () => {
  it("derives the MCP endpoint from the given origin", () => {
    expect(buildMcpConnectionDetails("https://brain.example.com").serverUrl).toBe("https://brain.example.com/mcp");
  });

  it("strips a trailing slash from the origin before appending the path", () => {
    expect(buildMcpConnectionDetails("https://brain.example.com/").serverUrl).toBe("https://brain.example.com/mcp");
  });

  it("builds an mcpServers JSON block keyed by this deployment's manifest id", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    expect(JSON.parse(details.configJson)).toEqual({
      mcpServers: { [mcpServerId]: { type: "http", url: "https://brain.example.com/mcp" } },
    });
  });

  it("builds the Claude Code CLI command for an HTTP transport", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    expect(details.claudeCodeCommand).toBe("claude mcp add --transport http second-brain https://brain.example.com/mcp");
  });

  it("builds the Codex CLI add and login commands for a streamable HTTP server", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    expect(details.codexAddCommand).toBe("codex mcp add second-brain --url https://brain.example.com/mcp");
    expect(details.codexLoginCommand).toBe("codex mcp login second-brain");
  });

  it("builds the Codex config.toml [mcp_servers.<name>] block", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    expect(details.codexConfigToml).toBe('[mcp_servers.second-brain]\nurl = "https://brain.example.com/mcp"');
  });

  it("builds a Replit install URL carrying only the display name and server URL, base64-encoded", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    expect(details.replitInstallUrl.startsWith("https://replit.com/integrations?mcp=")).toBe(true);
    const encoded = details.replitInstallUrl.slice("https://replit.com/integrations?mcp=".length);
    const decoded = JSON.parse(atob(decodeURIComponent(encoded)));
    expect(decoded).toEqual({ displayName: mcpServerId, baseUrl: "https://brain.example.com/mcp" });
  });

  it("never includes a credential, token, or secret placeholder", () => {
    const details = buildMcpConnectionDetails("https://brain.example.com");
    const blob = Object.values(details).join(" ").toLowerCase();
    expect(blob).not.toMatch(/token|bearer|secret|authorization/);
  });

  it("works for a loopback development origin too", () => {
    expect(buildMcpConnectionDetails("http://127.0.0.1:8080").serverUrl).toBe("http://127.0.0.1:8080/mcp");
  });
});

describe("isPubliclyReachableOrigin", () => {
  it("accepts a public HTTPS origin", () => {
    expect(isPubliclyReachableOrigin("https://brain.example.com")).toBe(true);
    expect(isPubliclyReachableOrigin("https://brain.example.com:8443")).toBe(true);
  });

  it("rejects loopback hostnames", () => {
    expect(isPubliclyReachableOrigin("http://127.0.0.1:8080")).toBe(false);
    expect(isPubliclyReachableOrigin("https://127.4.5.6")).toBe(false);
    expect(isPubliclyReachableOrigin("http://localhost:5173")).toBe(false);
    expect(isPubliclyReachableOrigin("https://[::1]")).toBe(false);
  });

  it("rejects RFC 1918 private ranges", () => {
    expect(isPubliclyReachableOrigin("https://10.1.2.3")).toBe(false);
    expect(isPubliclyReachableOrigin("https://172.16.0.5")).toBe(false);
    expect(isPubliclyReachableOrigin("https://172.31.255.255")).toBe(false);
    expect(isPubliclyReachableOrigin("https://192.168.1.5")).toBe(false);
  });

  it("keeps a public address in the 172.x range that falls outside 172.16/12 reachable", () => {
    expect(isPubliclyReachableOrigin("https://172.15.0.5")).toBe(true);
    expect(isPubliclyReachableOrigin("https://172.32.0.5")).toBe(true);
  });

  it("rejects link-local and unique-local IPv6 ranges", () => {
    expect(isPubliclyReachableOrigin("https://[fe80::1]")).toBe(false);
    expect(isPubliclyReachableOrigin("https://[fc00::1]")).toBe(false);
    expect(isPubliclyReachableOrigin("https://[fd12::1]")).toBe(false);
  });

  it("rejects mDNS .local hostnames", () => {
    expect(isPubliclyReachableOrigin("https://my-server.local")).toBe(false);
  });

  it("rejects a public hostname served over plain HTTP", () => {
    expect(isPubliclyReachableOrigin("http://brain.example.com")).toBe(false);
  });

  it("rejects an unparsable origin instead of throwing", () => {
    expect(isPubliclyReachableOrigin("not a url")).toBe(false);
  });
});

describe("connectClientOrder", () => {
  it("leads with ChatGPT when the brain is on a public website", () => {
    expect(defaultConnectClient(true)).toBe("chatgpt");
    expect(connectClientOrder(true)[0]).toBe("chatgpt");
  });

  it("leads with Claude Code when the brain is only on this computer", () => {
    expect(defaultConnectClient(false)).toBe("claudeCode");
    expect(connectClientOrder(false)[0]).toBe("claudeCode");
  });
});
