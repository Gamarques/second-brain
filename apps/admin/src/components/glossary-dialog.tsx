import { useMemo, useState } from "react";

import { glossaryDefinitionKey, glossaryIds, glossaryTermKey } from "../lib/glossary";
import { useTranslation } from "../lib/i18n";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/field";

/**
 * Browsable companion to the inline `<GlossaryTerm>` popovers: every term
 * used anywhere in the console, searchable in one place. Reachable from the
 * header's help button and from the command palette.
 */
export function GlossaryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslation();
  const [query, setQuery] = useState("");

  const entries = useMemo(
    () =>
      glossaryIds
        .map((id) => ({ id, term: t(glossaryTermKey(id)), definition: t(glossaryDefinitionKey(id)) }))
        .sort((left, right) => left.term.localeCompare(right.term)),
    [t],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter((entry) => entry.term.toLowerCase().includes(needle) || entry.definition.toLowerCase().includes(needle));
  }, [entries, query]);

  return (
    <Dialog description={t("glossary.dialog.description")} onClose={onClose} open={open} size="lg" title={t("glossary.dialog.title")}>
      <div className="grid gap-4">
        <Field htmlFor="glossary-search" label={t("glossary.dialog.searchLabel")}>
          <Input id="glossary-search" onChange={(event) => setQuery(event.target.value)} placeholder={t("glossary.dialog.searchPlaceholder")} type="search" value={query} />
        </Field>
        <p aria-live="polite" className="text-xs text-muted-foreground">{t("glossary.dialog.count", { count: matches.length })}</p>
        {matches.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("glossary.dialog.empty")}</p>
        ) : (
          <dl className="grid max-h-[55vh] gap-4 overflow-y-auto pr-1">
            {matches.map((entry) => (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3.5" key={entry.id}>
                <dt className="text-sm font-medium tracking-tight text-foreground">{entry.term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.definition}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Dialog>
  );
}
