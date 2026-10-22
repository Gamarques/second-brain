import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localeStorageKey } from "./locale";
import { LocaleProvider, useLocale, useTranslation } from "./provider";

function LocaleProbe() {
  const { locale, setLocale } = useLocale();
  const t = useTranslation();
  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="greeting">{t("shell.signOut")}</p>
      <p data-testid="count">{t("knowledge.documentCount", { count: 3 })}</p>
      <button onClick={() => setLocale("pt-BR")} type="button">pt-BR</button>
      <button onClick={() => setLocale("es")} type="button">es</button>
    </div>
  );
}

describe("LocaleProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = "";
  });
  afterEach(() => {
    document.documentElement.lang = "";
  });

  it("starts in English by default and paints the document lang", () => {
    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("greeting")).toHaveTextContent("Sign out");
    expect(document.documentElement.lang).toBe("en");
  });

  it("re-renders visible copy and persists the choice when the locale changes", async () => {
    const user = userEvent.setup();
    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    await user.click(screen.getByRole("button", { name: "pt-BR" }));

    expect(screen.getByTestId("locale")).toHaveTextContent("pt-BR");
    expect(screen.getByTestId("greeting")).toHaveTextContent("Sair");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(window.localStorage.getItem(localeStorageKey)).toBe("pt-BR");
  });

  it("applies Spanish pluralization through the count parameter", async () => {
    const user = userEvent.setup();
    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    await user.click(screen.getByRole("button", { name: "es" }));

    expect(screen.getByTestId("count")).toHaveTextContent("3 documentos");
  });

  it("restores a stored locale preference on the next visit", () => {
    window.localStorage.setItem(localeStorageKey, "es");

    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    expect(screen.getByTestId("locale")).toHaveTextContent("es");
    expect(screen.getByTestId("greeting")).toHaveTextContent("Cerrar sesión");
  });

  it("throws a clear error when used outside the provider", () => {
    function Bare() {
      useTranslation();
      return null;
    }
    expect(() => render(<Bare />)).toThrow("useLocale must be used inside a LocaleProvider.");
  });
});
