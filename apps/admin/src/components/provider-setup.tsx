import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { ModelMark } from "./brand-marks";
import { Meta, MetaItem } from "./page";
import { Alert } from "./ui/alert";
import type { BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Field, Select } from "./ui/field";

const targets = ["dreaming", "answer", "ingestion", "verification"] as const;
const services = ["engine", "admin", "automation-worker"] as const;

export function ProviderSetup({ changes, onChange, revision }: { changes: Record<string, string | null>; onChange(name: string, value: string): void; revision: number }) {
  const t = useTranslation();
  const [target, setTarget] = useState<typeof targets[number]>("dreaming");
  const [findModels, setFindModels] = useState(false);
  const status = useQuery({ queryKey: ["model-configuration", revision], queryFn: ({ signal }) => api.modelConfiguration(signal), refetchInterval: 15_000 });
  const catalog = useQuery({ queryKey: ["model-catalog"], queryFn: ({ signal }) => api.modelCatalog(signal), enabled: findModels, staleTime: 300_000 });
  const variable = `OPENROUTER_${target.toUpperCase()}_MODEL`;
  const model = changes[variable] ?? status.data?.saved.models[target] ?? "";
  const draftKey = changes.OPENROUTER_API_KEY;
  const needsSave = Object.values(changes).some((value) => value === null);
  const epoch = useRef(0);
  const probe = useMutation({
    mutationFn: async () => {
      const testedEpoch = epoch.current;
      const result = await api.probeModel({ model, ...(typeof draftKey === "string" ? { apiKey: draftKey } : {}) });
      return { result, epoch: testedEpoch };
    },
  });
  useEffect(() => {
    epoch.current += 1;
    probe.reset();
  }, [model, draftKey, revision, status.data?.saved.revision]);
  const result = probe.data?.epoch === epoch.current ? probe.data.result : undefined;

  function runtimeState(instance: NonNullable<typeof status.data>["runtimes"][number]): { label: string; tone: BadgeTone } {
    if (!instance.healthy) return { label: t("models.stale"), tone: "danger" };
    const applied = instance.configurationRevision === status.data!.saved.revision && instance.models[target] === status.data!.saved.models[target];
    return applied ? { label: t("models.applied"), tone: "success" } : { label: t("models.pending"), tone: "warning" };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("models.setup.title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isError && <Alert title={t("models.statusFailed")} tone="danger" />}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:items-end">
          <Field htmlFor="provider-target" label={t("models.feature")}>
            <Select id="provider-target" onChange={(event) => setTarget(event.target.value as typeof target)} value={target}>
              {targets.map((value) => (
                <option key={value} value={value}>{t(`models.target.${value}`)}</option>
              ))}
            </Select>
          </Field>
          <div className="flex h-8 min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-muted-foreground">{t("models.selectedLabel")}</span>
            <code className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-code px-2 py-1 font-mono text-xs text-code-foreground">
              <ModelMark className="size-3 shrink-0 opacity-80" model={model} />
              <span className="truncate">{model || t("common.notConfigured")}</span>
            </code>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!model.trim() || draftKey === "" || needsSave || status.isPending} loading={probe.isPending} onClick={() => probe.mutate()}>
            {!probe.isPending && <FlaskConical aria-hidden="true" />}
            {t("models.test")}
          </Button>
          <Button loading={catalog.isFetching} onClick={() => setFindModels(true)} variant="outline">
            {!catalog.isFetching && <Search aria-hidden="true" />}
            {t("models.find")}
          </Button>
          <p className="text-xs text-muted-foreground sm:ml-1">{t("models.testCost")}</p>
        </div>
        {needsSave && <Alert title={t("models.saveDefaults")} tone="warning" />}
        {catalog.isFetching && <p className="sr-only" role="status">{t("common.working")}</p>}
        {catalog.isError && <Alert title={t("models.catalogFailed")} tone="danger" />}
        {catalog.data && (
          <Field className="sm:max-w-md" hint={t("models.catalogHint")} htmlFor="provider-catalog" label={t("models.compatible")}>
            <Select
              id="provider-catalog"
              onChange={(event) => {
                if (event.target.value) onChange(variable, event.target.value);
              }}
              value=""
            >
              <option value="">{t("models.choose")}</option>
              {catalog.data.models.map((item) => (
                <option key={item.id} value={item.id}>{item.name} — {item.id}</option>
              ))}
            </Select>
          </Field>
        )}
        {probe.isError && <Alert title={t("models.probeFailed")} tone="danger" />}
        {result && (
          <Alert title={result.ok ? t("models.passed") : t("models.failed")} tone={result.ok ? "success" : "danger"}>
            {result.ok ? t("models.passedHint") : t(`models.error.${result.reason ?? "unknown"}`)}
          </Alert>
        )}
        {status.data && (
          <div className="grid gap-1 border-t border-border/60 pt-4">
            <Meta>
              <MetaItem>{t("models.savedRevision", { revision: status.data.saved.revision })}</MetaItem>
              <MetaItem>{t("models.runtimeRefresh")}</MetaItem>
            </Meta>
            <ul className="divide-y divide-border/60">
              {services.map((service) => {
                const instances = status.data.runtimes.filter((item) => item.service === service);
                return (
                  <li className="grid gap-2 py-2.5 text-sm" key={service}>
                    {instances.length === 0 ? (
                      <div className="flex items-center justify-between gap-3">
                        <code className="font-mono text-xs text-foreground">{service}</code>
                        <span className="text-xs text-muted-foreground">{t("models.runtimeUnknownShort")}</span>
                      </div>
                    ) : (
                      instances.map((instance) => {
                        const state = runtimeState(instance);
                        return (
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1" key={instance.id}>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <code className="font-mono text-xs text-foreground">{service}</code>
                              <span className="text-xs text-muted-foreground">v{instance.configurationRevision}</span>
                              <code className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
                                <ModelMark className="size-3 shrink-0 opacity-80" model={instance.models[target]} />
                                <span className="truncate">{instance.models[target] ?? t("common.notConfigured")}</span>
                              </code>
                            </div>
                            <MetaItem tone={state.tone}>
                              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                              {state.label}
                            </MetaItem>
                          </div>
                        );
                      })
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
