import { Illustration, type IllustrationProps } from "./illustration";

/** An inbox tray with one card rising out of it, its corner lit. */
export function EmptyLearningIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <rect height="30" rx="3" width="44" x="58" y="34" />
          <path d="M66 44h22M66 52h16" opacity="0.5" />
          <circle cx="100" cy="36" fill={sunrise} r="4" stroke="none" />
          <path d="M28 70v16a4 4 0 0 0 4 4h96a4 4 0 0 0 4-4V70" />
          <path d="M28 70h30l6 8h32l6-8h30" />
        </>
      )}
    </Illustration>
  );
}
