import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { ModelOperation } from "../lib/model-types";
import { TextLink } from "./ui/link";
import { BarRow } from "./viz/bar-row";

/**
 * Last week's AI requests by feature, busiest first, as four quiet bars.
 * Renders nothing until there is something to compare, so the settings page
 * never shows an empty chart.
 */
export function UsageByFeature() {
  const t = useTranslation();
  const usage = useQuery({ queryKey: ["model-usage", { days: 7 }], queryFn: ({ signal }) => api.modelUsage({ days: 7 }, signal), staleTime: 60_000 });
  if (!usage.data) return null;

  const totals = new Map<ModelOperation, number>();
  for (const group of usage.data.groups) totals.set(group.operation, (totals.get(group.operation) ?? 0) + group.requests);
  const rows = [...totals].filter(([, requests]) => requests > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (rows.length === 0) return null;
  const max = rows[0]![1];

  return (
    <section aria-labelledby="usage-by-feature-title" className="grid gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground" id="usage-by-feature-title">{t("configuration.usage.title")}</p>
        <TextLink className="text-xs" to="/usage">{t("configuration.usage.link")}</TextLink>
      </div>
      {rows.map(([operation, requests]) => (
        <BarRow key={operation} label={t(`usage.operation.${operation}`)} max={max} value={requests} valueLabel={t("configuration.usage.requests", { count: requests })} />
      ))}
    </section>
  );
}
