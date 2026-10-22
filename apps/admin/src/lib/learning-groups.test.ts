import { describe, expect, it } from "vitest";

import { groupByPeriod } from "./learning-groups";

const now = Date.parse("2026-09-08T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
const item = (id: string, createdAt: string) => ({ id, createdAt });

describe("groupByPeriod", () => {
  it("splits the last seven days from everything before, keeping the order it was given", () => {
    const groups = groupByPeriod([item("a", daysAgo(0)), item("b", daysAgo(6.9)), item("c", daysAgo(7.1)), item("d", daysAgo(40))], now);

    expect(groups.map((group) => [group.period, group.items.map((entry) => entry.id)])).toEqual([
      ["thisWeek", ["a", "b"]],
      ["earlier", ["c", "d"]],
    ]);
  });

  it("leaves out a period with nothing in it", () => {
    expect(groupByPeriod([item("a", daysAgo(1))], now).map((group) => group.period)).toEqual(["thisWeek"]);
    expect(groupByPeriod([item("a", daysAgo(30))], now).map((group) => group.period)).toEqual(["earlier"]);
    expect(groupByPeriod([], now)).toEqual([]);
  });

  it("files a timestamp it cannot read under earlier rather than dropping it", () => {
    const [group] = groupByPeriod([item("a", "not-a-date")], now);

    expect(group?.period).toBe("earlier");
    expect(group?.items.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("folds earlier only when it is long and something newer sits above it", () => {
    const week = [item("w", daysAgo(1))];
    const longEarlier = Array.from({ length: 6 }, (_, index) => item(`e${index}`, daysAgo(10 + index)));

    expect(groupByPeriod([...week, ...longEarlier], now).map((group) => group.folded)).toEqual([false, true]);
    expect(groupByPeriod([...week, ...longEarlier.slice(0, 5)], now).map((group) => group.folded)).toEqual([false, false]);
    expect(groupByPeriod(longEarlier, now).map((group) => group.folded)).toEqual([false]);
  });
});
