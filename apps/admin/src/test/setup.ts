import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node >= 25 ships a global Web Storage that shadows jsdom's, and its
// `localStorage` is undefined without --localstorage-file. Restore jsdom's
// Storage objects so tests behave the same on every supported Node version.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
if (jsdomWindow !== undefined) {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    if (typeof globalThis[name]?.clear !== "function") {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => jsdomWindow[name],
      });
    }
  }
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

afterEach(() => {
  cleanup();
});
