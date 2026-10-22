import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { ManifestCard } from "./manifest-card";

describe("ManifestCard", () => {
  it("names the pack, its publisher, revision and inventory, with the publisher's initial as the mark", () => {
    render(
      <LocaleProvider>
        <ManifestCard counts={{ collections: 2, documents: 14 }} packId="00000000-0000-4000-8000-000000000001" packRevision={3} publisher={{ namespace: "academy.example", displayName: "Example" }} title="Product guides" />
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading", { name: "Product guides" })).toBeVisible();
    expect(screen.getByText("Example")).toBeVisible();
    expect(screen.getByText("academy.example")).toBeVisible();
    expect(screen.getByText("Revision 3")).toBeVisible();
    expect(screen.getByText("2 folders")).toBeVisible();
    expect(screen.getByText("14 documents")).toBeVisible();
    expect(screen.getByText("E", { selector: "[data-publisher-mark]" })).toBeInTheDocument();
  });

  it("falls back to a neutral mark and title when the pack has no publisher yet", () => {
    render(
      <LocaleProvider>
        <ManifestCard counts={null} packId={null} packRevision={null} publisher={null} title={null} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading", { name: "Untitled pack" })).toBeVisible();
    expect(screen.getByText("?", { selector: "[data-publisher-mark]" })).toBeInTheDocument();
  });
});
