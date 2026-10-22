import { Illustration, type IllustrationProps } from "./illustration";

/** A small constellation with one lit node and one place still waiting to be joined. */
export function EmptyMapIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M44.4 65.9L67.6 44.1M77 43.4L99 58.6M107.3 67L120.7 87M43.7 74.8L56.3 91.2" />
          <path d="M108.4 57.9L127.6 40.1" opacity="0.5" strokeDasharray="2 4" />
          <circle cx="40" cy="70" r="4" />
          <circle cx="104" cy="62" r="4" />
          <circle cx="124" cy="92" r="4" />
          <circle cx="60" cy="96" r="4" />
          <circle cx="132" cy="36" opacity="0.5" r="4" strokeDasharray="2 3" />
          <circle cx="72" cy="40" fill={sunrise} r="5" stroke="none" />
        </>
      )}
    </Illustration>
  );
}
