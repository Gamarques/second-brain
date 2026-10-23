import { describe, expect, it } from "vitest";

import { OpenAICompatibleAdapter } from "../src/providers/openai-compatible-adapter.js";
import { PROVIDER_PRESETS } from "../src/providers/provider-presets.js";

describe("provider presets", () => {
  it.each(Object.values(PROVIDER_PRESETS))("$name builds a valid adapter", (preset) => {
    const adapter = new OpenAICompatibleAdapter({ ...preset.options, apiKey: "test-key" });
    expect(adapter.kind).toBe(preset.options.kind);
    expect(adapter.baseUrl).toBe(preset.options.baseUrl);
    expect(adapter.headers()["user-agent"] ?? adapter.headers()["User-Agent"]).toMatch(/^second-brain\//u);
  });

  it("sends the OpenCode session header and never the OpenRouter fields", () => {
    const adapter = new OpenAICompatibleAdapter({ ...PROVIDER_PRESETS["opencode-go"].options, apiKey: "k" });
    const headers = adapter.headers();
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(lower["x-title"]).toBeUndefined();
    expect(lower["http-referer"]).toBeUndefined();
  });

  it("only the local preset may run without a key", () => {
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      const adapter = new OpenAICompatibleAdapter({ ...preset.options });
      if (preset.options.allowUnauthenticated === true) expect(() => adapter.headers()).not.toThrow();
      else expect(() => adapter.headers()).toThrow();
    }
  });

  it("states how much of each preset was verified live", () => {
    expect(PROVIDER_PRESETS["opencode-go"].verified).toBe("live");
    expect(Object.values(PROVIDER_PRESETS).filter((p) => p.verified === "live").map((p) => p.name)).toEqual(["opencode-go"]);
  });
});
