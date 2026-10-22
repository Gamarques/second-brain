import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Provenance } from "../lib/api-types";
import { AnthropicMark, ModelMark, resolveSource, SourceMark } from "./brand-marks";

const provenance = (overrides: Partial<Provenance>): Provenance => ({ kind: "account", accountId: null, clientId: null, source: "admin", ...overrides });

describe("resolveSource", () => {
  it.each([
    [provenance({ kind: "account" }), "you"],
    [provenance({ kind: "oauth_client", source: "mcp_http", clientId: "client-1" }), "ai"],
    [provenance({ kind: "oauth_client", source: "Claude Desktop" }), "claude"],
    [provenance({ kind: "oauth_client", source: "mcp_http", clientId: "claude-code" }), "claude"],
    [provenance({ kind: "oauth_client", source: "ChatGPT" }), "chatgpt"],
    [provenance({ kind: "oauth_client", source: "slack-bot" }), "slack"],
    [provenance({ kind: "oauth_client", source: "telegram" }), "telegram"],
    [provenance({ kind: "dreaming", source: "worker" }), "nightly"],
    [provenance({ kind: "import", source: "csv" }), "import"],
    [provenance({ kind: "system", source: "migration" }), "system"],
  ])("%o → %s", (input, expected) => {
    expect(resolveSource(input)).toBe(expected);
  });
});

describe("marks", () => {
  it("draws a vendor mark only for vendors it knows", () => {
    const { container, rerender } = render(<ModelMark model="deepseek/deepseek-chat" />);
    expect(container.querySelector("svg")).toBeNull();

    rerender(<ModelMark model="anthropic/claude-sonnet-4" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("is decorative unless titled", () => {
    const { container, rerender } = render(<AnthropicMark />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<AnthropicMark title="Anthropic" />);
    expect(container.querySelector("svg")).toHaveAttribute("role", "img");
    expect(container.querySelector("svg title")).toHaveTextContent("Anthropic");
  });

  it("picks the Slack mark for a Slack-sourced memory", () => {
    const { container } = render(<SourceMark provenance={provenance({ kind: "oauth_client", source: "slack" })} />);

    expect(container.querySelector("svg[data-mark='slack']")).not.toBeNull();
  });
});
