import { Illustration, type IllustrationProps } from "./illustration";

/** A sheet with a folded corner and its first line lit. */
export function EmptyDocumentsIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M52 24h40l16 16v56a3 3 0 0 1-3 3H52a3 3 0 0 1-3-3V27a3 3 0 0 1 3-3z" />
          <path d="M92 24v16h16" />
          <path d="M62 46h22" stroke={sunrise} strokeWidth="2.5" />
          <path d="M62 58h36M62 68h36M62 78h24" opacity="0.5" />
        </>
      )}
    </Illustration>
  );
}
