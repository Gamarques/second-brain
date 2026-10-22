import { afterEach, expect, it, vi } from "vitest";
import { createModelConfigurationService } from "../src/providers/model-configuration.js";

afterEach(() => vi.unstubAllGlobals());
const reader = { async read() { return { configurationRevision: 4, environment: { OPENROUTER_API_KEY: "saved-test-key", OPENROUTER_ANSWER_MODEL: "test/fallback", OPENROUTER_DREAMING_MODEL: "test/dreaming" } }; } };
const signal = new AbortController().signal;

it("resolves saved fallbacks without exposing a key", async () => {
  const service = createModelConfigurationService(reader, vi.fn());
  const status = await service.status(signal);
  expect(status).toMatchObject({ revision: 4, hasApiKey: true, models: { dreaming: "test/dreaming", answer: "test/fallback", ingestion: "test/fallback", verification: "test/fallback" } });
  expect(JSON.stringify(status)).not.toContain("saved-test-key");
});

it("deduplicates only endpoints with structured JSON support from the ZDR catalog", async () => {
  const endpoint = { model_id: "test/valid", model_name: "Valid", supported_parameters: ["response_format", "structured_outputs"] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [endpoint, endpoint, { ...endpoint, model_id: "test/invalid", supported_parameters: ["response_format"] }] })));
  const result = await createModelConfigurationService(reader, vi.fn()).models(signal);
  expect(result.models).toEqual([{ id: "test/valid", name: "Valid" }]);
});

it("uses a draft key for the probe without changing saved configuration", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }));
  vi.stubGlobal("fetch", fetchMock);
  const service = createModelConfigurationService(reader, vi.fn());
  expect(await service.probe({ model: "test/new", apiKey: "draft-test-key" }, signal)).toMatchObject({ ok: true, model: "test/new" });
  expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer draft-test-key");
  expect((await service.status(signal)).models.dreaming).toBe("test/dreaming");
});

it("reports malformed model output and transport failure as separate safe reasons", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "length", message: { content: "private response" } }] })).mockRejectedValueOnce(new Error("private network address"));
  vi.stubGlobal("fetch", fetchMock);
  const service = createModelConfigurationService(reader, vi.fn());
  expect(await service.probe({ model: "test/model" }, signal)).toMatchObject({ ok: false, reason: "malformed" });
  const network = await service.probe({ model: "test/model" }, signal);
  expect(network).toMatchObject({ ok: false, reason: "network" });
  expect(JSON.stringify(network)).not.toContain("private");
});
