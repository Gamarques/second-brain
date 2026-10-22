import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { Breadcrumbs } from "./breadcrumbs";

function renderTrail(pathname: string) {
  render(<LocaleProvider><MemoryRouter><Breadcrumbs pathname={pathname} /></MemoryRouter></LocaleProvider>);
}

describe("Breadcrumbs", () => {
  it("links every ancestor and leaves the current page as plain text", () => {
    renderTrail("/knowledge/base-1/documents/doc-1");

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail).toHaveTextContent("Documents");
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute("href", "/knowledge");
    expect(screen.getByRole("link", { name: "Folder" })).toHaveAttribute("href", "/knowledge/base-1");
    expect(screen.queryByRole("link", { name: "Document" })).not.toBeInTheDocument();
    expect(screen.getByText("Document")).toHaveAttribute("aria-current", "page");
  });

  it("starts every trail at the brain itself, so a top-level route reads as Second Brain / Page", () => {
    renderTrail("/memories");

    expect(screen.getByRole("link", { name: "Second Brain" })).toHaveAttribute("href", "/");
    expect(screen.getByText("Things to remember")).toHaveAttribute("aria-current", "page");
  });

  it("does not link the brain to itself on Home", () => {
    renderTrail("/");

    expect(screen.queryByRole("link", { name: "Second Brain" })).not.toBeInTheDocument();
    expect(screen.getByText("Home")).toHaveAttribute("aria-current", "page");
  });
});
