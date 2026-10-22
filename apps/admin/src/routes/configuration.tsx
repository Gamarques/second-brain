import { ProviderSetup } from "../components/provider-setup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ErrorState, PageSkeleton } from "../components/async-state";
import { Meta, MetaItem, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardHeaderText,
  CardTitle,
} from "../components/ui/card";
import { ButtonLink } from "../components/ui/button-link";
import { ConfirmDialog } from "../components/ui/dialog";
import { Disclosure } from "../components/ui/disclosure";
import { Field, Input } from "../components/ui/field";
import { ExternalTextLink } from "../components/ui/link";
import { useToast } from "../components/ui/toast";
import { UsageByFeature } from "../components/usage-by-feature";
import { api } from "../lib/api";
import type { ConfigEntry } from "../lib/api-types";
import { useLocale, useTranslation, type Translator } from "../lib/i18n";
import { cn, newIdempotencyKey } from "../lib/utils";

export function ConfigurationPage() {
  const client = useQueryClient();
  const { toast } = useToast();
  const { locale } = useLocale();
  const t = useTranslation();
  const [searchParams] = useSearchParams();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [confirmRestart, setConfirmRestart] = useState(false);
  const query = useQuery({
    queryKey: ["configuration", locale],
    queryFn: ({ signal }) => api.config(signal, locale),
  });
  const changedEntries = useMemo(
    () => Object.entries(changes).map(([name, value]) => ({ name, value })),
    [changes],
  );

  const stage = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error(t("configuration.notLoadedError"));
      return api.stageConfig({
        expectedRevision: query.data.revision,
        changes: changedEntries,
        idempotencyKey: newIdempotencyKey("config-stage"),
      });
    },
    onSuccess: (result) => {
      setChanges({});
      setRevealed({});
      client.invalidateQueries({ queryKey: ["configuration"] });
      toast({
        title: t("configuration.toast.staged.title", {
          count: result.changedNames.length,
        }),
        description: result.restartRequired
          ? t("configuration.toast.staged.restartNeeded")
          : t("configuration.toast.staged.live"),
        tone: "success",
      });
    },
    onError: (error: unknown) => {
      toast({
        title: t("configuration.toast.stageFailed.title"),
        description:
          error instanceof Error
            ? error.message
            : t("configuration.toast.stageFailed.fallback"),
        tone: "danger",
      });
    },
  });

  const restart = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error(t("configuration.notLoadedError"));
      return api.restartConfigurationServices({
        expectedRevision: query.data.revision,
        idempotencyKey: newIdempotencyKey("config-restart"),
      });
    },
    onSuccess: (result) => {
      setConfirmRestart(false);
      client.invalidateQueries({ queryKey: ["configuration"] });
      toast({
        title: t("configuration.toast.restarted.title"),
        description: t("configuration.toast.restarted.description", {
          targets: result.targets.join(", "),
        }),
        tone: "success",
        duration: 8_000,
      });
    },
    onError: (error: unknown) => {
      toast({
        title: t("configuration.toast.restartFailed.title"),
        description:
          error instanceof Error
            ? error.message
            : t("configuration.toast.restartFailed.fallback"),
        tone: "danger",
      });
    },
  });

  if (query.isPending) {
    return <PageSkeleton cards={2} label={t("configuration.loading")} />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} retry={() => query.refetch()} />;
  }

  const apiKey = query.data.entries.find(
    (entry) => entry.name === "OPENROUTER_API_KEY",
  );
  const advancedEntries = query.data.entries.filter(
    (entry) => entry.name !== "OPENROUTER_API_KEY" && entry.name !== "OPENROUTER_DREAMING_MODEL",
  );
  const dreamingModel = query.data.entries.find((entry) => entry.name === "OPENROUTER_DREAMING_MODEL");
  const hasBlankChanges = changedEntries.some(({ value }) => value !== null && value.trim() === "");
  const change = (name: string, value: string | null) => {
    setChanges((current) => ({ ...current, [name]: value }));
  };
  const discard = (name: string) => {
    setChanges((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  return (
    <Page>
      <PageHeader
        description={t("configuration.description")}
        eyebrow={t("configuration.revisionEyebrow", {
          revision: query.data.revision,
        })}
        title={t("route.environment")}
      />

      {query.data.restartRequired && (
        <Alert
          aria-label={t("configuration.applyPending.title")}
          title={t("configuration.applyPending.title")}
          tone="warning"
        >
          <p>{t("configuration.applyPending.description")}</p>
          <Button
            className="mt-3"
            loading={restart.isPending}
            onClick={() => setConfirmRestart(true)}
            size="sm"
          >
            {!restart.isPending && <RefreshCw aria-hidden="true" />}
            {restart.isPending
              ? t("common.restarting")
              : t("configuration.applyPending.button")}
          </Button>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
        <div className="grid gap-6">
      {apiKey && (
        <Card>
          <CardHeader className="gap-2">
            <CardTitle>{t("configuration.essentials.title")}</CardTitle>
            <Meta>
              <MetaItem>{t("configuration.essentials.provider")}</MetaItem>
              <MetaItem icon={apiKey.isSet ? Check : undefined} tone={apiKey.isSet ? "success" : "neutral"}>
                {apiKey.isSet ? t("configuration.essentials.savedBadge") : t("configuration.essentials.serverBadge")}
              </MetaItem>
              {!apiKey.isSet && (
                <ExternalTextLink className="text-xs" href="https://openrouter.ai/keys">
                  {t("configuration.essentials.getKeyLinkLabel")}
                </ExternalTextLink>
              )}
            </Meta>
          </CardHeader>
          <CardContent className="grid gap-5">
            <ConfigurationEditor
              changes={changes}
              entry={apiKey}
              label={t("configuration.essentials.fieldLabel")}
              onChange={(value) => change(apiKey.name, value)}
              onDiscard={() => discard(apiKey.name)}
              onReveal={() =>
                setRevealed((current) => ({
                  ...current,
                  [apiKey.name]: !current[apiKey.name],
                }))
              }
              prominent
              revealed={revealed[apiKey.name] ?? false}
              t={t}
            />
            <UsageByFeature />
          </CardContent>
          {apiKey.isSet && changedEntries.length === 0 && !query.data.restartRequired && (
            <CardFooter className="border-t border-border/60 pt-4 sm:pt-4">
              <ButtonLink size="sm" to="/connect">
                {t("configuration.essentials.nextConnect")}
              </ButtonLink>
            </CardFooter>
          )}
        </Card>
      )}

      <ProviderSetup changes={changes} onChange={change} revision={query.data.revision} />
        </div>
        <div className="grid gap-6">

      {dreamingModel && (
        <Card>
          <CardHeader>
            <CardTitle>{t("configuration.dreaming.title")}</CardTitle>
            <CardDescription>{t("configuration.dreaming.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ConfigurationEditor
              autoFocus={searchParams.get("focus") === "dreaming"}
              changes={changes}
              entry={dreamingModel}
              label={settingLabel(dreamingModel.name, t)}
              onChange={(value) => change(dreamingModel.name, value)}
              onDiscard={() => discard(dreamingModel.name)}
              onReveal={() => undefined}
              revealed={false}
              t={t}
            />
            <Disclosure size="sm" summary={t("configuration.dreaming.requirementsSummary")}>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("configuration.dreaming.requirements")}{" "}
                <ExternalTextLink className="text-xs" href="https://openrouter.ai/docs/guides/features/zdr">
                  {t("configuration.dreaming.privacyLink")}
                </ExternalTextLink>
              </p>
            </Disclosure>
          </CardContent>
          <CardFooter className="border-t border-border/60 pt-4 sm:pt-4">
            <ButtonLink size="sm" to="/automation/dreaming" variant="ghost">
              {t("configuration.dreaming.scheduleLink")}
            </ButtonLink>
          </CardFooter>
        </Card>
      )}

      {advancedEntries.length > 0 && (
        <Card>
          <button
            aria-label={t("configuration.advanced.title")}
            aria-expanded={showAdvanced}
            className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl p-4 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 sm:p-5"
            onClick={() => setShowAdvanced((current) => !current)}
            type="button"
          >
            <CardHeaderText>
              <CardTitle>{t("configuration.advanced.title")}</CardTitle>
              <CardDescription>
                {t("configuration.advanced.description")}
              </CardDescription>
            </CardHeaderText>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                showAdvanced && "rotate-180",
              )}
            />
          </button>
          {showAdvanced && (
            <section
              aria-label={t("configuration.advanced.title")}
              className="divide-y divide-border/60 border-t border-border/60"
              role="region"
            >
              <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">{t("configuration.advanced.note")}</p>
              {advancedEntries.map((entry) => (
                <div className="grid gap-4 p-4 sm:p-5" key={entry.name}>
                  <ConfigurationEditor
                    changes={changes}
                    entry={entry}
                    label={settingLabel(entry.name, t)}
                    onChange={(value) => change(entry.name, value)}
                    onDiscard={() => discard(entry.name)}
                    onReveal={() =>
                      setRevealed((current) => ({
                        ...current,
                        [entry.name]: !current[entry.name],
                      }))
                    }
                    revealed={revealed[entry.name] ?? false}
                    t={t}
                  />
                </div>
              ))}
            </section>
          )}
        </Card>
      )}

        </div>
      </div>

      {changedEntries.length > 0 && (
        <Alert
          className="sticky bottom-4 z-10 shadow-lg"
          aria-label={t("configuration.pendingChanges.title", {
            count: changedEntries.length,
          })}
          title={t("configuration.pendingChanges.title", {
            count: changedEntries.length,
          })}
          tone="warning"
        >
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button disabled={hasBlankChanges} loading={stage.isPending} onClick={() => stage.mutate()} size="sm">
              {!stage.isPending && <Save aria-hidden="true" />}
              {stage.isPending
                ? t("configuration.staging")
                : t("configuration.pendingChanges.saveButton", {
                    count: changedEntries.length,
                  })}
            </Button>
            <Button onClick={() => setChanges({})} size="sm" variant="ghost">
              {t("configuration.pendingChanges.discardButton")}
            </Button>
          </div>
        </Alert>
      )}

      <ConfirmDialog
        confirmLabel={t("configuration.applyPending.button")}
        description={t("configuration.confirmRestart.description")}
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => restart.mutate()}
        open={confirmRestart}
        pending={restart.isPending}
        title={t("configuration.confirmRestart.title")}
      >
        <div className="grid gap-4">
          <div className="flex gap-3">
            <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("configuration.confirmRestart.willHappen.title")}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t("configuration.confirmRestart.willHappen.body")}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("configuration.confirmRestart.willNotHappen.title")}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t("configuration.confirmRestart.willNotHappen.body")}</p>
            </div>
          </div>
        </div>
      </ConfirmDialog>
    </Page>
  );
}

function settingLabel(name: string, t: Translator): string {
  switch (name) {
    case "OPENROUTER_ANSWER_MODEL":
      return t("configuration.setting.answerModel");
    case "OPENROUTER_INGESTION_MODEL":
      return t("configuration.setting.ingestionModel");
    case "OPENROUTER_DREAMING_MODEL":
      return t("configuration.setting.dreamingModel");
    case "OPENROUTER_VERIFICATION_MODEL":
      return t("configuration.setting.verificationModel");
    case "OPENROUTER_REQUEST_TIMEOUT_MS":
      return t("configuration.setting.requestTimeout");
    case "OPENROUTER_APP_URL":
      return t("configuration.setting.appUrl");
    default:
      return name;
  }
}

function ConfigurationEditor({
  entry,
  changes,
  label,
  prominent = false,
  autoFocus = false,
  revealed,
  onReveal,
  onChange,
  onDiscard,
  t,
}: {
  entry: ConfigEntry;
  changes: Record<string, string | null>;
  label: string;
  prominent?: boolean;
  autoFocus?: boolean;
  revealed: boolean;
  onReveal: () => void;
  onChange: (value: string | null) => void;
  onDiscard: () => void;
  t: Translator;
}) {
  const hasLocalChange = Object.hasOwn(changes, entry.name);
  const pendingValue = changes[entry.name];
  const savedValue = entry.isSecret ? "" : entry.maskedValue ?? "";
  const inputValue = hasLocalChange ? pendingValue ?? "" : savedValue;
  const inputId = `configuration-${entry.name.toLowerCase().replaceAll("_", "-")}`;
  const placeholder = entry.isSecret
    ? entry.isSet
      ? t("configuration.essentials.placeholderSaved")
      : t("configuration.essentials.placeholderEmpty")
    : t("common.useDefault");
  const hint = prominent ? (entry.isSet ? t("configuration.essentials.savedHint") : t("configuration.essentials.emptyHint")) : undefined;

  return (
    <Field
      error={hasLocalChange && pendingValue !== null && pendingValue?.trim() === "" ? t("configuration.blankValue") : entry.validationError}
      {...(hint ? { hint } : {})}
      htmlFor={inputId}
      label={label}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Input
            autoFocus={autoFocus}
            data-route-focus={autoFocus || undefined}
            className={cn(entry.isSecret && "pr-10")}
            disabled={!entry.editable}
            id={inputId}
            onChange={(event) => {
              const value = event.target.value;
              if (value === savedValue) onDiscard();
              else onChange(value);
            }}
            placeholder={placeholder}
            type={entry.isSecret && !revealed ? "password" : "text"}
            value={inputValue}
          />
          {entry.isSecret && entry.editable && (
            <Button
              aria-label={
                revealed
                  ? t("configuration.reveal.hide")
                  : t("configuration.reveal.show")
              }
              className="absolute right-0.5 top-0.5 text-muted-foreground hover:text-foreground"
              onClick={onReveal}
              size="icon-sm"
              variant="ghost"
            >
              {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          )}
        </div>
        {entry.editable && entry.isSet && (!hasLocalChange || pendingValue !== null) && (
          <Button onClick={() => onChange(null)} size="sm" variant="ghost">
            {prominent
              ? t("configuration.essentials.removeSavedKey")
              : t("configuration.advanced.useServerDefault")}
          </Button>
        )}
        {hasLocalChange && (
          <Button onClick={onDiscard} size="sm" variant="ghost">
            <RotateCcw aria-hidden="true" />
            {t("configuration.advanced.discardChange")}
          </Button>
        )}
      </div>
      {hasLocalChange && pendingValue === null && (
        <p className="text-xs font-medium text-warning">
          {t("configuration.overrideWillClear")}
        </p>
      )}
      {!prominent && (
        <Meta>
          <MetaItem><code className="font-mono">{entry.name}</code></MetaItem>
          <MetaItem tone={entry.isSet ? "success" : "neutral"}>{entry.isSet ? t("configuration.advanced.overrideBadge") : t("configuration.advanced.defaultBadge")}</MetaItem>
        </Meta>
      )}
    </Field>
  );
}
