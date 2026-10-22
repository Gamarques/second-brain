import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { commandKeyLabel, isAskPanelShortcut, isCommandPaletteShortcut, useAskPanelShortcut, useCommandPaletteShortcut } from "./shortcuts";

function keyboardEvent(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", init);
  if (init.target) Object.defineProperty(event, "target", { value: init.target });
  return event;
}

describe("command palette shortcut", () => {
  it("matches the platform command key", () => {
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "k", metaKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "K", ctrlKey: true }))).toBe(true);
  });

  it("matches a bare slash so the palette opens like a search box", () => {
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "/" }))).toBe(true);
  });

  it("never steals a slash typed into a form control", () => {
    const input = document.createElement("input");
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "/", target: input }))).toBe(false);
  });

  it("never steals a slash typed into rich text", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "/", target: editable }))).toBe(false);
  });

  it("ignores unrelated keys", () => {
    expect(isCommandPaletteShortcut(keyboardEvent({ key: "j", metaKey: true }))).toBe(false);
  });

  it("opens the palette from anywhere in the document", () => {
    const open = vi.fn();
    function Probe() {
      useCommandPaletteShortcut(open);
      return null;
    }
    const view = render(<Probe />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(open).toHaveBeenCalledTimes(1);

    view.unmount();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("command key label", () => {
  it("shows the Apple command glyph on macOS", () => {
    expect(commandKeyLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("⌘");
  });

  it("shows Ctrl everywhere else", () => {
    expect(commandKeyLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl");
    expect(commandKeyLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl");
  });
});

describe("ask panel shortcut", () => {
  it("matches the platform command key with J", () => {
    expect(isAskPanelShortcut(keyboardEvent({ key: "j", metaKey: true }))).toBe(true);
    expect(isAskPanelShortcut(keyboardEvent({ key: "J", ctrlKey: true }))).toBe(true);
    expect(isAskPanelShortcut(keyboardEvent({ key: "j" }))).toBe(false);
    expect(isAskPanelShortcut(keyboardEvent({ key: "k", ctrlKey: true }))).toBe(false);
  });

  it("toggles the panel from anywhere in the document", () => {
    const toggle = vi.fn();
    function Probe() {
      useAskPanelShortcut(toggle);
      return null;
    }
    render(<Probe />);
    fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
