import { Illustration, type IllustrationProps } from "./illustration";

/** A board with three columns; one card is lit, the rest still waiting to be written. */
export function EmptyProjectsIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M28 24h32M64 24h32M100 24h32" opacity="0.5" />
          <rect height="14" rx="3" width="32" x="28" y="32" />
          <rect height="14" rx="3" width="32" x="28" y="52" />
          <rect height="14" opacity="0.5" rx="3" width="32" x="28" y="72" />
          <rect fill={sunrise} height="14" rx="3" stroke="none" width="32" x="64" y="32" />
          <rect height="14" rx="3" width="32" x="64" y="52" />
          <rect height="14" rx="3" width="32" x="100" y="32" />
          <rect height="14" opacity="0.4" rx="3" strokeDasharray="2 3" width="32" x="100" y="52" />
        </>
      )}
    </Illustration>
  );
}
