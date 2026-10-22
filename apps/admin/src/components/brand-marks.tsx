import { Bot, Cog, MoonStar, Upload, User } from "lucide-react";

import type { Provenance } from "../lib/api-types";
import type { CatalogKey } from "../lib/i18n/catalog";
import { cn } from "../lib/utils";

/*
 * Brand glyphs, drawn in `currentColor` so they sit in a meta line like any
 * other icon. Paths are from simple-icons (https://simpleicons.org, CC0 1.0).
 */
const paths = {
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  telegram:
    "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  openai:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  anthropic:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  replit:
    "M2 1.5A1.5 1.5 0 0 1 3.5 0h7A1.5 1.5 0 0 1 12 1.5V8H3.5A1.5 1.5 0 0 1 2 6.5ZM12 8h8.5A1.5 1.5 0 0 1 22 9.5v5a1.5 1.5 0 0 1-1.5 1.5H12ZM2 17.5A1.5 1.5 0 0 1 3.5 16H12v6.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 22.5Z",
} as const;

export interface MarkProps {
  className?: string | undefined;
  /** Names the mark for assistive tech; without it the mark is decorative. */
  title?: string | undefined;
}

function Mark({ name, className, title }: MarkProps & { name: keyof typeof paths }) {
  return (
    <svg aria-hidden={title ? undefined : "true"} className={cn("size-4 shrink-0", className)} data-mark={name} fill="currentColor" role={title ? "img" : undefined} viewBox="0 0 24 24">
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

export const SlackMark = (props: MarkProps) => <Mark {...props} name="slack" />;
export const TelegramMark = (props: MarkProps) => <Mark {...props} name="telegram" />;
export const OpenAIMark = (props: MarkProps) => <Mark {...props} name="openai" />;
export const AnthropicMark = (props: MarkProps) => <Mark {...props} name="anthropic" />;
export const ReplitMark = (props: MarkProps) => <Mark {...props} name="replit" />;

export type SourceKind = "you" | "claude" | "chatgpt" | "slack" | "telegram" | "ai" | "nightly" | "import" | "system";

/**
 * Who saved a record, as far as the provenance can say. `kind` is a closed set;
 * `source` and `clientId` are free text, so a client is only named when the
 * text names it — otherwise it stays "your AI", which is always true.
 */
export function resolveSource({ kind, source, clientId }: Pick<Provenance, "kind" | "source" | "clientId">): SourceKind {
  switch (kind) {
    case "account":
      return "you";
    case "dreaming":
      return "nightly";
    case "import":
      return "import";
    case "system":
      return "system";
    case "oauth_client": {
      const hint = `${source} ${clientId ?? ""}`.toLowerCase();
      if (/claude|anthropic/.test(hint)) return "claude";
      if (/chatgpt|openai|codex/.test(hint)) return "chatgpt";
      if (/slack/.test(hint)) return "slack";
      if (/telegram/.test(hint)) return "telegram";
      return "ai";
    }
  }
}

const sourceLabelKeys: Record<SourceKind, CatalogKey> = {
  you: "memories.origin.account",
  ai: "memories.origin.oauth_client",
  nightly: "memories.origin.dreaming",
  import: "memories.origin.import",
  system: "memories.origin.system",
  claude: "memories.origin.claude",
  chatgpt: "memories.origin.chatgpt",
  slack: "memories.origin.slack",
  telegram: "memories.origin.telegram",
};

export function sourceLabelKey(kind: SourceKind): CatalogKey {
  return sourceLabelKeys[kind];
}

const genericMarks = { you: User, ai: Bot, nightly: MoonStar, import: Upload, system: Cog } as const;

/** The glyph for who saved a record; sized for a meta line. */
export function SourceMark({ provenance, className }: { provenance: Provenance; className?: string }) {
  const kind = resolveSource(provenance);
  const size = cn("size-3", className);
  switch (kind) {
    case "claude":
      return <AnthropicMark className={size} />;
    case "chatgpt":
      return <OpenAIMark className={size} />;
    case "slack":
      return <SlackMark className={size} />;
    case "telegram":
      return <TelegramMark className={size} />;
    default: {
      const Icon = genericMarks[kind];
      return <Icon aria-hidden="true" className={size} />;
    }
  }
}

/** The vendor mark for an OpenRouter model id (`vendor/model`); nothing for vendors without one. */
export function ModelMark({ model, className }: { model: string | null | undefined; className?: string }) {
  const vendor = model?.split("/")[0]?.toLowerCase();
  if (vendor === "anthropic") return <AnthropicMark className={className} />;
  if (vendor === "openai") return <OpenAIMark className={className} />;
  return null;
}

export function ChannelMark({ kind, className }: { kind: "slack" | "telegram"; className?: string }) {
  return kind === "slack" ? <SlackMark className={className} /> : <TelegramMark className={className} />;
}
