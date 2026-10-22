import { Illustration, type IllustrationProps } from "./illustration";

/** A timeline with room for its first entries; the most recent point is lit. */
export function EmptyActivityIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M48 30v66" opacity="0.5" />
          <circle cx="48" cy="40" fill={sunrise} r="4.5" stroke="none" />
          <circle cx="48" cy="64" r="3.5" />
          <circle cx="48" cy="88" r="3.5" />
          <path d="M60 38h52M60 45h30" opacity="0.6" />
          <path d="M60 62h44M60 69h24" opacity="0.4" />
          <path d="M60 86h36M60 93h20" opacity="0.25" />
        </>
      )}
    </Illustration>
  );
}
