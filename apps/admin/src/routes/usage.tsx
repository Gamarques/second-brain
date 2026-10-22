import { useQuery } from "@tanstack/react-query";
import { Activity, ChartColumn, Coins, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, PageSkeleton } from "../components/async-state";
import { EmptyUsageIllustration } from "../components/illustrations/empty-usage";
import { Metric, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Field, Input, Select } from "../components/ui/field";
import { Table, Td, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { modelOperations, type ModelOperation } from "../lib/model-types";

export function UsagePage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const [budget, setBudget] = useState(() => {
    try {
      return localStorage.getItem("second-brain.usage-budget-credits") ?? "";
    } catch {
      return "";
    }
  });
  const [days, setDays] = useState(30);
  const [operation, setOperation] = useState<ModelOperation | "">("");
  const [model, setModel] = useState("");
  const query = useQuery({ queryKey: ["model-usage", days, operation], queryFn: ({ signal }) => api.modelUsage({ days, ...(operation ? { operation } : {}) }, signal), refetchInterval: 30_000 });
  const monthly = useQuery({ queryKey: ["model-usage", 30, ""], queryFn: ({ signal }) => api.modelUsage({ days: 30 }, signal), refetchInterval: 30_000 });
  const monthlyCost = monthly.data?.groups.reduce((sum, row) => sum + row.reportedCost, 0) ?? 0;
  const budgetAmount = Number(budget);
  const budgetWarning = Number.isFinite(budgetAmount) && budgetAmount > 0 && monthlyCost >= budgetAmount * 0.8;
  const rows = query.data?.groups.filter((row) => row.model.toLowerCase().includes(model.toLowerCase())) ?? [];
  const total = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      failures: sum.failures + row.failures,
      tokens: sum.tokens + row.inputTokens + row.outputTokens,
      tokensCovered: sum.tokensCovered + row.tokenCoverage,
      cost: sum.cost + row.reportedCost,
      covered: sum.covered + row.costCoverage,
    }),
    { requests: 0, failures: 0, tokens: 0, tokensCovered: 0, cost: 0, covered: 0 },
  );
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const money = (value: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);

  return (
    <Page>
      <PageHeader description={t("usage.description")} title={t("usage.title")} />
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-3 sm:pt-6">
          <Field htmlFor="usage-days" label={t("usage.period")}>
            <Select id="usage-days" onChange={(event) => setDays(Number(event.target.value))} value={days}>
              {[1, 7, 30, 90].map((value) => (
                <option key={value} value={value}>{t("usage.days", { count: value })}</option>
              ))}
            </Select>
          </Field>
          <Field htmlFor="usage-operation" label={t("models.feature")}>
            <Select id="usage-operation" onChange={(event) => setOperation(event.target.value as typeof operation)} value={operation}>
              <option value="">{t("usage.all")}</option>
              {modelOperations.map((value) => (
                <option key={value} value={value}>{t(`usage.operation.${value}`)}</option>
              ))}
            </Select>
          </Field>
          <Field htmlFor="usage-model" label={t("usage.model")}>
            <Input id="usage-model" onChange={(event) => setModel(event.target.value)} placeholder="openai/…" type="search" value={model} />
          </Field>
        </CardContent>
      </Card>
      {query.isPending ? (
        <PageSkeleton cards={2} metrics={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={Activity} label={t("usage.requests")} value={number(total.requests)} />
            <Metric detail={t("usage.tokenCoverage", { covered: total.tokensCovered, total: total.requests })} icon={ChartColumn} label={t("usage.tokens")} value={total.tokensCovered ? number(total.tokens) : t("usage.unknown")} />
            <Metric detail={t("usage.coverage", { covered: total.covered, total: total.requests })} icon={Coins} label={t("usage.cost")} tone={total.covered === 0 ? "neutral" : "info"} value={total.covered === 0 ? t("usage.unknown") : money(total.cost)} />
            <Metric icon={TriangleAlert} label={t("usage.failures")} tone={total.failures ? "warning" : "neutral"} value={number(total.failures)} />
          </div>
          {total.failures > 0 && <Alert title={t("usage.failureNotice", { count: total.failures })} tone="warning" />}
          {total.covered < total.requests && <Alert title={t("usage.incomplete")} tone="warning" />}
          {query.data.truncated && <Alert title={t("usage.truncated")} tone="warning" />}
          {rows.length === 0 ? (
            <EmptyState description={t("usage.emptyHint")} illustration={<EmptyUsageIllustration />} title={t("usage.empty")} />
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {rows.map((row) => (
                  <Card key={`${row.operation}:${row.model}`}>
                    <CardHeader>
                      <CardTitle className="text-sm">{t(`usage.operation.${row.operation}`)}</CardTitle>
                      <CardDescription className="break-words font-mono text-xs">{row.model}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div><dt className="text-xs text-muted-foreground">{t("usage.requests")}</dt><dd className="font-medium tabular-nums">{number(row.requests)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">{t("usage.failures")}</dt><dd className="font-medium tabular-nums">{number(row.failures)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">{t("usage.tokens")}</dt><dd className="font-medium tabular-nums">{row.tokenCoverage ? number(row.inputTokens + row.outputTokens) : t("usage.unknown")}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">{t("usage.duration")}</dt><dd className="font-medium tabular-nums">{number(row.averageDurationMs)} ms</dd></div>
                        <div className="col-span-2">
                          <dt className="text-xs text-muted-foreground">{t("usage.cost")}</dt>
                          <dd className="font-medium tabular-nums">{row.costCoverage ? money(row.reportedCost) : t("usage.unknown")}</dd>
                          <p className="text-xs text-muted-foreground">{t("usage.coverage", { covered: row.costCoverage, total: row.requests })}</p>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Card className="hidden md:block">
                <CardContent className="p-0 sm:p-0">
                  <Table className="min-w-[850px]">
                    <thead>
                      <Tr className="hover:bg-transparent">
                        <Th>{t("models.feature")}</Th>
                        <Th>{t("usage.model")}</Th>
                        <Th className="text-right">{t("usage.requests")}</Th>
                        <Th className="text-right">{t("usage.tokens")}</Th>
                        <Th className="text-right">{t("usage.cost")}</Th>
                        <Th className="text-right">{t("usage.duration")}</Th>
                        <Th className="text-right">{t("usage.failures")}</Th>
                      </Tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <Tr key={`${row.operation}:${row.model}`}>
                          <Td className="font-medium">{t(`usage.operation.${row.operation}`)}</Td>
                          <Td className="min-w-44 max-w-64 break-words font-mono text-xs text-muted-foreground">{row.model}</Td>
                          <Td className="text-right tabular-nums">{number(row.requests)}</Td>
                          <Td className="text-right tabular-nums">{row.tokenCoverage ? number(row.inputTokens + row.outputTokens) : t("usage.unknown")}</Td>
                          <Td className="text-right tabular-nums">
                            {row.costCoverage ? money(row.reportedCost) : t("usage.unknown")}
                            <p className="text-xs text-muted-foreground">{t("usage.coverage", { covered: row.costCoverage, total: row.requests })}</p>
                          </Td>
                          <Td className="text-right tabular-nums">{number(row.averageDurationMs)} ms</Td>
                          <Td className="text-right tabular-nums">
                            {row.failures > 0 ? <Badge tone="warning">{number(row.failures)}</Badge> : number(row.failures)}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
          {!model && query.data.failures.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("usage.failures")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm">
                  {query.data.failures.map((failure) => (
                    <li className="flex items-start gap-3" key={failure.reason}>
                      <Badge tone="warning">{number(failure.count)}</Badge>
                      <span className="leading-relaxed text-foreground/90">{t(`models.error.${failure.reason ?? "unknown"}`)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("usage.scope")}</p>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("usage.budget")}
          </CardTitle>
          <CardDescription>{t("usage.budgetHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 sm:max-w-xs">
            <label className="sr-only" htmlFor="usage-budget">{t("usage.budget")}</label>
            <Input
              id="usage-budget"
              max="1000000"
              min="0.01"
              onChange={(event) => {
                const value = event.target.value;
                setBudget(value);
                try {
                  localStorage.setItem("second-brain.usage-budget-credits", value);
                } catch {
                  /* This browser may disable preference storage. */
                }
              }}
              placeholder="USD"
              step="0.01"
              type="number"
              value={budget}
            />
          </div>
          {budgetWarning && <Alert title={t(monthlyCost >= budgetAmount ? "usage.budgetExceeded" : "usage.budgetNear")} tone="warning" />}
          {monthly.isError && <Alert title={t("usage.budgetUnavailable")} tone="warning" />}
        </CardContent>
      </Card>
    </Page>
  );
}
