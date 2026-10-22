import { House, RefreshCw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { useTranslation } from "../lib/i18n";
import { Button } from "./ui/button";
import { ButtonLink } from "./ui/button-link";

const reloadStampKey = "second-brain-admin.chunk-reload-at";
const reloadCooldownMs = 60_000;

/** A route chunk that the server no longer has, typically after a deploy replaced the build. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|Failed to fetch dynamically/i.test(message);
}

/** Reload at most once per minute so a genuinely broken build cannot loop the browser. */
export function shouldReloadForChunk(now: number = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(reloadStampKey) ?? 0);
    if (now - last < reloadCooldownMs) return false;
    window.sessionStorage.setItem(reloadStampKey, String(now));
    return true;
  } catch {
    return true;
  }
}

interface Props {
  children: ReactNode;
  /** When this changes (for example the pathname), a caught error is cleared so the next page can render. */
  resetKey?: string;
  reload?: () => void;
}

interface State {
  error: unknown;
  failed: boolean;
}

/**
 * Keeps the console usable when a page throws. A stale route chunk after a
 * deploy reloads the page once; any other error shows a recovery card
 * instead of the blank screen React leaves behind.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error) && shouldReloadForChunk()) {
      (this.props.reload ?? (() => window.location.reload()))();
      return;
    }
    console.error(error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null, failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RouteErrorFallback onReset={() => this.setState({ error: null, failed: false })} reload={this.props.reload ?? (() => window.location.reload())} />;
  }
}

export function RouteErrorFallback({ onReset, reload }: { onReset: () => void; reload: () => void }) {
  const t = useTranslation();
  return (
    <div className="grid min-h-[50vh] place-items-center text-center" role="alert">
      <div className="flex max-w-md flex-col items-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="size-6" />
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{t("errorBoundary.title")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("errorBoundary.body")}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button onClick={reload}>
            <RefreshCw aria-hidden="true" />
            {t("errorBoundary.reload")}
          </Button>
          <ButtonLink onClick={onReset} to="/" variant="outline">
            <House aria-hidden="true" />
            {t("errorBoundary.home")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
