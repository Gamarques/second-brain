import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { translate } from "./i18n/catalog";
import { defaultLocale, type Locale } from "./i18n/locale";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null | undefined, locale: Locale = defaultLocale): string {
  if (!value) return translate(locale, "common.emptyValue");
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

/**
 * A list row's timestamp: day, month, and time, with the year only when it is
 * not the current one. Malformed values stay visible for diagnosis.
 */
export function formatShortDateTime(value: string, locale: Locale = defaultLocale, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

export function formatNumber(value: number, locale: Locale = defaultLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function localDateTimeToIso(value: string): string | undefined {
  if (value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

export function formatRelativeTime(value: string | null | undefined, now: number = Date.now(), locale: Locale = defaultLocale): string {
  if (!value) return translate(locale, "common.emptyValue");
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const difference = date.valueOf() - now;
  if (Math.abs(difference) < 45_000) return translate(locale, "common.justNow");
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, milliseconds] of relativeUnits) {
    if (Math.abs(difference) >= milliseconds) {
      return formatter.format(Math.round(difference / milliseconds), unit);
    }
  }
  return formatter.format(Math.round(difference / 1_000), "second");
}
