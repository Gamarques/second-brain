import { Illustration, type IllustrationProps } from "./illustration";

/** A sealed parcel seen from a corner; the tape down its middle is the one lit seam. */
export function EmptyPacksIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          {/* the three visible faces */}
          <path d="M40 56h56v44H40z" />
          <path d="M40 56l16-16h56l-16 16z" />
          <path d="M96 56l16-16v44l-16 16z" />
          {/* a label and a stamp on the front */}
          <path d="M48 84h20" opacity="0.4" />
          <rect height="8" opacity="0.4" rx="1" width="10" x="80" y="64" />
          {/* the seam that seals it */}
          <path d="M76 40v60" stroke={sunrise} strokeWidth="3" />
        </>
      )}
    </Illustration>
  );
}
