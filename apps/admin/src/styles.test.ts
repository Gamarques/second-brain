import { describe, expect, it } from "vitest";

import css from "./styles.css?raw";

/**
 * Tailwind puts its utilities in a cascade layer, and unlayered author CSS
 * always beats layered CSS. An element reset outside `@layer base` therefore
 * silently overrides every `text-*`, `font-*` and `border-*` utility on the
 * elements it names — buttons rendered at the body font size, sidebar group
 * labels ignored `text-[11px]`, and tinted borders came out grey.
 */
function unlayeredRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const stack: string[] = [];
  let header = "";
  let body = "";
  for (const char of css) {
    if (char === "{") {
      stack.push(header.trim());
      header = "";
      body = "";
    } else if (char === "}") {
      const selector = stack.pop() ?? "";
      if (!stack.some((ancestor) => ancestor.startsWith("@layer")) && !selector.startsWith("@")) rules.push({ selector, body });
      header = "";
      body = "";
    } else if (stack.length === 0 || header !== "" || body === "") {
      // Between rules, or inside a rule before any declaration text.
      if (stack.length === 0) header += char;
      else body += char;
    } else {
      body += char;
    }
  }
  return rules;
}

describe("styles.css", () => {
  const rules = unlayeredRules(css);

  it("keeps form-control and code font resets inside @layer base so utilities can size them", () => {
    const offenders = rules.filter((rule) => /\b(button|input|textarea|select|code|pre|kbd)\b/.test(rule.selector) && /\bfont(-family)?\s*:/.test(rule.body));
    expect(offenders).toEqual([]);
  });

  it("keeps the default border colour inside @layer base so border-* utilities win", () => {
    const offenders = rules.filter((rule) => rule.selector.includes("*") && /border-color\s*:/.test(rule.body));
    expect(offenders).toEqual([]);
  });
});
