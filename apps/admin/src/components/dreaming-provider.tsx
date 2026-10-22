import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Settings2 } from "lucide-react";

import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { ErrorState } from "./async-state";
import { ModelMark } from "./brand-marks";
import { Alert } from "./ui/alert";
import { ButtonLink } from "./ui/button-link";
import { Disclosure } from "./ui/disclosure";
import { TextLink } from "./ui/link";
import { Skeleton } from "./ui/skeleton";

export const dreamingConfigurationPath = "/configuration/environment?focus=dreaming";

/** The model the review will use, on one line, with the way to change it. */
export function DreamingModelRow() {
  const { locale } = useLocale();
  const t = useTranslation();
  const query = useQuery({ queryKey: ["configuration", locale], queryFn: ({ signal }) => api.config(signal, locale) });
  const model = query.data?.entries.find((entry) => entry.name === "OPENROUTER_DREAMING_MODEL");
  const saved = model?.isSet && model.maskedValue ? model.maskedValue : null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
      <div className="grid min-w-0 flex-1 gap-3">
        {query.isPending ? (
          <Skeleton className="h-4 w-56" />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : (
          <>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:opacity-80">
              <ModelMark model={saved} />
              {saved ? t("dreaming.provider.savedModel", { model: saved }) : t("dreaming.provider.serverDefault")}
            </p>
            {query.data.restartRequired && (
              <Alert title={t("configuration.applyPending.title")} tone="warning">
                {t("configuration.applyPending.description")}
              </Alert>
            )}
          </>
        )}
      </div>
      <ButtonLink className="shrink-0" size="sm" to={dreamingConfigurationPath} variant="ghost">
        <Settings2 aria-hidden="true" />
        {t("dreaming.provider.configure")}
      </ButtonLink>
    </div>
  );
}

/**
 * Explains a failed review in plain words. `compact` keeps one line visible
 * and folds the guidance behind a disclosure, so a list of failures stays
 * scannable instead of repeating the same paragraph on every row.
 */
export function DreamingProviderError({ code, compact = false }: { code: string; compact?: boolean }) {
  const t = useTranslation();
  if (code !== "DREAMING_PROVIDER_FAILED") {
    return <code className="break-all font-mono text-xs text-danger">{code}</code>;
  }
  const guidance = (
    <div className="grid gap-1.5 text-xs">
      <p className="text-muted-foreground">{t("dreaming.provider.errorHelp")}</p>
      <TextLink className="text-xs" to={dreamingConfigurationPath}>
        {t("dreaming.provider.reviewSettings")}
        <ArrowRight aria-hidden="true" />
      </TextLink>
      <code className="break-all text-[11px] text-muted-foreground">{code}</code>
    </div>
  );
  if (compact) {
    return (
      <div className="grid gap-1 text-xs">
        <p className="font-medium text-danger">{t("dreaming.provider.errorShort")}</p>
        <Disclosure contentClassName="mt-1.5" summary={t("common.showDetails")}>{guidance}</Disclosure>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5 text-xs">
      <p className="font-medium text-danger">{t("dreaming.provider.error")}</p>
      {guidance}
    </div>
  );
}
