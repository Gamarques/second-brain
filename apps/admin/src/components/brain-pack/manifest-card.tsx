import type { BrainPackPublisher } from "../../lib/brain-pack-types";
import { useTranslation } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Meta, MetaItem } from "../page";
import { CopyableId } from "../ui/copy-button";

/** The publisher's initial on a sunrise-tinted square: the mark a pack carries wherever it is shown. */
export function PublisherMark({ publisher, className }: { publisher: BrainPackPublisher | null; className?: string }) {
  const initial = publisher?.displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={cn("aurora-soft flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-foreground", className)}
      data-publisher-mark=""
    >
      {initial}
    </span>
  );
}

/**
 * What a pack is, in one glance: the publisher's mark, the title, and a quiet
 * line with who published it, which revision this is, and how much it holds.
 * Drawn once here and reused in the preview, the history and the receipt.
 */
export function ManifestCard({
  title,
  publisher,
  packId,
  packRevision,
  counts,
  description,
  className,
}: {
  title: string | null;
  publisher: BrainPackPublisher | null;
  packId: string | null;
  packRevision: number | null;
  counts: { collections: number; documents: number } | null;
  description?: string | null;
  className?: string;
}) {
  const t = useTranslation();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <PublisherMark publisher={publisher} />
      <div className="grid min-w-0 gap-1">
        <h3 className="text-sm font-medium leading-snug text-foreground">{title ?? t("packs.run.untitled")}</h3>
        {description && <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        <Meta>
          {publisher && <MetaItem>{publisher.displayName}</MetaItem>}
          {publisher && <MetaItem className="font-mono">{publisher.namespace}</MetaItem>}
          {packRevision !== null && <MetaItem>{t("packs.run.revision", { revision: packRevision })}</MetaItem>}
          {counts && <MetaItem>{t("packs.count.folders", { count: counts.collections })}</MetaItem>}
          {counts && <MetaItem>{t("knowledge.documentCount", { count: counts.documents })}</MetaItem>}
        </Meta>
        {packId && (
          <Meta>
            <MetaItem><CopyableId label={t("common.id.packId")} value={packId} /></MetaItem>
          </Meta>
        )}
      </div>
    </div>
  );
}
