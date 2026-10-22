export type LearningPeriod = "thisWeek" | "earlier";

export interface LearningPeriodGroup<T> {
  period: LearningPeriod;
  items: T[];
  /** Whether the group starts closed, so a long tail does not bury what is new. */
  folded: boolean;
}

const weekMs = 7 * 24 * 60 * 60 * 1000;
/** Earlier starts folded past this many rows, and only when a newer group sits above it. */
const foldEarlierAbove = 5;

/**
 * Splits a chronological list into the last seven days and everything before,
 * in the order it was given: the server already sorts newest first and the
 * page must not reorder it. A timestamp that cannot be read counts as old.
 */
export function groupByPeriod<T extends { createdAt: string }>(items: readonly T[], now: number = Date.now()): LearningPeriodGroup<T>[] {
  const thisWeek: T[] = [];
  const earlier: T[] = [];
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    (Number.isFinite(at) && now - at < weekMs ? thisWeek : earlier).push(item);
  }
  const groups: LearningPeriodGroup<T>[] = [
    { period: "thisWeek", items: thisWeek, folded: false },
    { period: "earlier", items: earlier, folded: thisWeek.length > 0 && earlier.length > foldEarlierAbove },
  ];
  return groups.filter((group) => group.items.length > 0);
}
