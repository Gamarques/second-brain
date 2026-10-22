import { useEffect, useRef } from "react";

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.getAttribute("contenteditable") === "true") return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function isCommandPaletteShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") return true;
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return false;
  return !isTextEntry(event.target);
}

export function useCommandPaletteShortcut(onOpen: () => void): void {
  const handler = useRef(onOpen);
  handler.current = onOpen;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!isCommandPaletteShortcut(event)) return;
      event.preventDefault();
      handler.current();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}

export function isAskPanelShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j";
}

export function useAskPanelShortcut(onToggle: () => void): void {
  const handler = useRef(onToggle);
  handler.current = onToggle;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!isAskPanelShortcut(event)) return;
      event.preventDefault();
      handler.current();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}

export function commandKeyLabel(userAgent: string = navigator.userAgent): string {
  return /Mac|iPhone|iPad|iPod/.test(userAgent) ? "⌘" : "Ctrl";
}
