import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { ProviderSetup } from "./provider-setup";

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, "en");
  vi.spyOn(api, "modelConfiguration").mockResolvedValue({ saved: { revision: 3, hasApiKey: true, models: { dreaming: "test/old", answer: "test/answer" } }, runtimes: [{ id: "worker", service: "automation-worker", configurationRevision: 2, models: { dreaming: "test/old" }, healthy: true, startedAt: "2026-09-04T00:00:00Z", lastSeenAt: "2026-09-04T00:00:00Z" }] });
  vi.spyOn(api, "modelCatalog").mockResolvedValue({ models: [{ id: "test/new", name: "New" }], checkedAt: "2026-09-04T00:00:00Z" });
  vi.spyOn(api, "probeModel").mockResolvedValue({ ok: true, reason: null, model: "test/old", checkedAt: "2026-09-04T00:00:00Z", durationMs: 5 });
});

function Form() {
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  return <ProviderSetup changes={changes} onChange={(name, value) => setChanges({ ...changes, [name]: value })} revision={3} />;
}
it("tests explicitly, distinguishes loaded revisions and invalidates success after a model edit", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider><Form /></LocaleProvider></QueryClientProvider></MemoryRouter>);
  const worker = (await screen.findByText("automation-worker")).closest("li")!;
  expect(within(worker).getByText("v2")).toBeVisible();
  expect(within(worker).getByText("Restart pending")).toBeVisible();
  expect(api.probeModel).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Test this configuration" }));
  expect(await screen.findByText("Configuration passed the test")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Find compatible models" }));
  await user.selectOptions(await screen.findByLabelText("Compatible model"), "test/new");
  expect(screen.queryByText("Configuration passed the test")).not.toBeInTheDocument();
  expect(api.probeModel).toHaveBeenCalledTimes(1);
});

it("invalidates a successful probe when another administrator changes the saved key revision", async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><LocaleProvider><Form /></LocaleProvider></QueryClientProvider></MemoryRouter>);
  await screen.findByText("automation-worker");
  await user.click(screen.getByRole("button", { name: "Test this configuration" }));
  expect(await screen.findByText("Configuration passed the test")).toBeVisible();
  const previous = await api.modelConfiguration();
  act(() => { client.setQueryData(["model-configuration", 3], { ...previous, saved: { ...previous.saved, revision: 4 } }); });
  await waitFor(() => expect(screen.queryByText("Configuration passed the test")).not.toBeInTheDocument());
});
