import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { api } from "../lib/api";
import { RemindersPage } from "./reminders";
afterEach(() => vi.restoreAllMocks());
it("requires confirmation before enabling external delivery and snoozes the exact reminder version", async () => {
  vi.spyOn(api, "me").mockResolvedValue({
    accountId: "owner",
    email: "owner@example.test",
    role: "owner",
  } as never);
  vi.spyOn(api, "automationSettings").mockResolvedValue({
    revision: 4,
    reminderDeliveryEnabled: false,
  } as never);
  vi.spyOn(api, "notificationChannels").mockResolvedValue({
    encryptionAvailable: true,
    channels: [
      {
        id: "channel",
        kind: "telegram",
        name: "Personal",
        destination: "42",
        enabled: true,
        verifiedAt: "2026-09-01T00:00:00Z",
        revision: 1,
      },
    ],
  });
  vi.spyOn(api, "notificationDeliveries").mockResolvedValue({
    deliveries: [],
    nextCursor: null,
  });
  vi.spyOn(api, "reminders").mockResolvedValue({
    reminders: [
      {
        id: "reminder",
        message: "Review proposal",
        version: 3,
        remindAt: "2026-09-01T00:00:00Z",
        completedAt: null,
      },
    ],
    nextCursor: null,
  });
  const enable = vi
    .spyOn(api, "updateAutomationSettings")
    .mockResolvedValue({} as never);
  const update = vi.spyOn(api, "updateReminder").mockResolvedValue({} as never);
  localStorage.setItem(localeStorageKey, "en");
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MemoryRouter>
          <RemindersPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
  await user.click(
    await screen.findByRole("switch", { name: "Automatic delivery" }),
  );
  expect(enable).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm delivery" }));
  await waitFor(() =>
    expect(enable).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderDeliveryEnabled: true,
        expectedRevision: 4,
      }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Snooze" }));
  await user.type(screen.getByLabelText("New time"), "2027-01-01T12:00");
  await user.click(screen.getByRole("button", { name: "Confirm snooze" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reminder",
        expectedVersion: 3,
        completed: false,
        remindAt: expect.any(String),
      }),
    ),
  );
});

it("puts what is due first and keeps delivery setup beside it, without numbered steps", async () => {
  vi.spyOn(api, "me").mockResolvedValue({ accountId: "owner", email: "owner@example.test", role: "owner" } as never);
  vi.spyOn(api, "automationSettings").mockResolvedValue({ revision: 4, reminderDeliveryEnabled: false } as never);
  vi.spyOn(api, "notificationChannels").mockResolvedValue({ encryptionAvailable: true, channels: [] });
  vi.spyOn(api, "notificationDeliveries").mockResolvedValue({ deliveries: [], nextCursor: null });
  vi.spyOn(api, "reminders").mockResolvedValue({
    reminders: [{ id: "reminder", message: "Review proposal", version: 3, remindAt: "2026-09-01T00:00:00Z", completedAt: null }],
    nextCursor: null,
  });
  localStorage.setItem(localeStorageKey, "en");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter>
          <RemindersPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );

  const reminders = await screen.findByRole("heading", { name: "Your reminders" });
  const delivery = screen.getByRole("heading", { name: "Delivery" });
  expect(reminders.compareDocumentPosition(delivery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(/^1\. /)).not.toBeInTheDocument();
  expect(within(delivery.closest("section")!).getByRole("button", { name: "Add channel" })).toBeVisible();
});

it("keeps the delivery history out of the way until there is one, and marks channels by service", async () => {
  vi.spyOn(api, "me").mockResolvedValue({ accountId: "owner", email: "owner@example.test", role: "owner" } as never);
  vi.spyOn(api, "automationSettings").mockResolvedValue({ revision: 4, reminderDeliveryEnabled: false } as never);
  vi.spyOn(api, "notificationChannels").mockResolvedValue({
    encryptionAvailable: true,
    channels: [{ id: "channel", kind: "telegram", name: "Personal", destination: "42", enabled: true, verifiedAt: "2026-09-01T00:00:00Z", revision: 1 }],
  });
  vi.spyOn(api, "notificationDeliveries").mockResolvedValue({ deliveries: [], nextCursor: null });
  vi.spyOn(api, "reminders").mockResolvedValue({
    reminders: [{ id: "reminder", message: "Review proposal", version: 3, remindAt: "2026-09-01T00:00:00Z", completedAt: null }],
    nextCursor: null,
  });
  localStorage.setItem(localeStorageKey, "en");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter>
          <RemindersPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );

  await screen.findByRole("heading", { name: "Your reminders" });
  expect(screen.queryByRole("heading", { name: "Delivery history" })).not.toBeInTheDocument();
  const delivery = screen.getByRole("heading", { name: "Delivery" }).closest("section")!;
  const channel = within(delivery).getByText("Personal").closest("li")!;
  expect(channel.querySelector("svg[data-mark='telegram']")).not.toBeNull();
  expect(within(channel).getByText("42")).toBeVisible();
  expect(within(delivery).queryByText("Telegram")).not.toBeInTheDocument();
  expect(channel.querySelector(".rounded-full.border")).toBeNull();
  expect(screen.getAllByRole("listitem").every((item) => item.querySelectorAll(".rounded-full.border").length <= 1)).toBe(true);
});

it("offers quick times when scheduling, so nobody has to type a date", async () => {
  vi.spyOn(api, "me").mockResolvedValue({ accountId: "owner", email: "owner@example.test", role: "owner" } as never);
  vi.spyOn(api, "automationSettings").mockResolvedValue({ revision: 4, reminderDeliveryEnabled: false } as never);
  vi.spyOn(api, "notificationChannels").mockResolvedValue({ encryptionAvailable: true, channels: [] });
  vi.spyOn(api, "notificationDeliveries").mockResolvedValue({ deliveries: [], nextCursor: null });
  vi.spyOn(api, "reminders").mockResolvedValue({ reminders: [], nextCursor: null });
  const create = vi.spyOn(api, "createReminder").mockResolvedValue({} as never);
  localStorage.setItem(localeStorageKey, "en");
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter>
          <RemindersPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );

  await user.click((await screen.findAllByRole("button", { name: "New reminder" }))[0]!);
  await user.type(screen.getByLabelText("Reminder message"), "Call the accountant");
  await user.click(screen.getByRole("button", { name: "Tomorrow 9:00" }));
  const time = screen.getByLabelText("When to remind me") as HTMLInputElement;
  expect(time.value).toMatch(/T09:00$/);
  expect(new Date(time.value).getTime()).toBeGreaterThan(Date.now());

  await user.click(screen.getByRole("button", { name: "Create reminder" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ message: "Call the accountant" })));
});
