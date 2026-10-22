import { describe, expect, it, vi } from "vitest";

import { formatDate, formatRelativeTime, formatShortDateTime, localDateTimeToIso, newIdempotencyKey, toLocalDateTimeInput } from "./utils";

describe("admin utilities", () => {
  it("returns an em dash when a timestamp is absent", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("keeps malformed timestamps visible for diagnosis", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });

  it("creates namespaced idempotency keys", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    expect(newIdempotencyKey("config-stage")).toBe(
      "config-stage:00000000-0000-4000-8000-000000000001",
    );
  });

  it("round-trips timestamps through a local datetime control", () => {
    const source = "2026-08-23T12:30:00.000Z";
    expect(localDateTimeToIso(toLocalDateTimeInput(source))).toBe(source);
  });

  it("describes recent timestamps in relative terms", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-24T11:59:50.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-08-24T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-08-24T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-08-21T12:00:00.000Z", now)).toBe("3 days ago");
  });

  it("describes future timestamps without pretending they are past", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-24T14:00:00.000Z", now)).toBe("in 2 hours");
  });

  it("keeps unusable relative timestamps visible", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("describes relative timestamps in Portuguese", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-24T11:59:50.000Z", now, "pt-BR")).toBe("agora mesmo");
    expect(formatRelativeTime("2026-08-24T11:55:00.000Z", now, "pt-BR")).toBe("há 5 minutos");
    expect(formatRelativeTime("2026-08-24T09:00:00.000Z", now, "pt-BR")).toBe("há 3 horas");
    expect(formatRelativeTime("2026-08-21T12:00:00.000Z", now, "pt-BR")).toBe("há 3 dias");
    expect(formatRelativeTime("2026-08-24T14:00:00.000Z", now, "pt-BR")).toBe("em 2 horas");
    expect(formatRelativeTime(null, now, "pt-BR")).toBe("—");
  });

  it("describes relative timestamps in Spanish", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-24T11:59:50.000Z", now, "es")).toBe("ahora mismo");
    expect(formatRelativeTime("2026-08-24T11:55:00.000Z", now, "es")).toBe("hace 5 minutos");
    expect(formatRelativeTime("2026-08-24T09:00:00.000Z", now, "es")).toBe("hace 3 horas");
    expect(formatRelativeTime("2026-08-21T12:00:00.000Z", now, "es")).toBe("hace 3 días");
    expect(formatRelativeTime("2026-08-24T14:00:00.000Z", now, "es")).toBe("dentro de 2 horas");
    expect(formatRelativeTime(null, now, "es")).toBe("—");
  });

  it("formats an absent date with the active locale's em dash", () => {
    expect(formatDate(null, "pt-BR")).toBe("—");
    expect(formatDate(null, "es")).toBe("—");
  });

  it("formats a list timestamp as day, month, and time, adding the year only when it is not the current one", () => {
    const now = new Date("2026-09-08T12:00:00Z");

    expect(formatShortDateTime("2026-09-07T12:00:00Z", "en", now)).toMatch(/Sep 7/);
    expect(formatShortDateTime("2026-09-07T12:00:00Z", "en", now)).not.toMatch(/2026/);
    expect(formatShortDateTime("2025-09-07T12:00:00Z", "en", now)).toMatch(/2025/);
    expect(formatShortDateTime("2026-09-07T12:00:00Z", "pt-BR", now)).toMatch(/7 de set/);
    expect(formatShortDateTime("not-a-date", "en", now)).toBe("not-a-date");
  });
});
