import { Illustration, type IllustrationProps } from "./illustration";

/** Three folders, back to front; the front one is open with a sheet peeking out and its tab lit. */
export function EmptyFoldersIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          {/* back folder: only what the others do not cover */}
          <path d="M60 34v-6a4 4 0 0 1 4-4h18l6 6h44a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4h-4" opacity="0.4" />
          {/* middle folder */}
          <path d="M50 46v-6a4 4 0 0 1 4-4h18l6 6h46a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4h-4" opacity="0.65" />
          {/* sheet peeking from the front folder */}
          <path d="M56 58v-9a2 2 0 0 1 2-2h32a2 2 0 0 1 2 2v9" />
          <path d="M64 51h20M64 55h12" opacity="0.5" />
          {/* front folder tab, lit */}
          <path d="M40 60v-2a4 4 0 0 1 4-4h20l6 6z" fill={sunrise} stroke="none" />
          {/* front folder */}
          <path d="M40 66v-8a4 4 0 0 1 4-4h20l6 6h46a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H44a4 4 0 0 1-4-4z" />
        </>
      )}
    </Illustration>
  );
}
