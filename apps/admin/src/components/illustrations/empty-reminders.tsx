import { Illustration, type IllustrationProps } from "./illustration";

/** A bell at rest, two dotted arcs where the ring would go, and a lit clapper. */
export function EmptyRemindersIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          {/* the ring, not yet sounding */}
          <path d="M44 50a34 34 0 0 0 0 30M116 50a34 34 0 0 1 0 30" opacity="0.5" strokeDasharray="1.5 4.5" />
          {/* bell */}
          <path d="M77 40a3 3 0 1 1 6 0" />
          <path d="M62 78V58a18 18 0 0 1 36 0v20l6 6H56z" />
          <path d="M68 60a12 12 0 0 1 8-11" opacity="0.4" />
          {/* clapper */}
          <circle cx="80" cy="91" fill={sunrise} r="4" stroke="none" />
        </>
      )}
    </Illustration>
  );
}
