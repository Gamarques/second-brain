import { Illustration, type IllustrationProps } from "./illustration";

/** An open notebook: a few quiet lines on the left page, one bright line waiting on the right. */
export function EmptyMemoriesIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          {/* pages */}
          <path d="M28 36c16-5 34-5 50-2v60c-16-3-34-3-50 2z" />
          <path d="M132 36c-16-5-34-5-50-2v60c16-3 34-3 50 2z" />
          {/* spine and the gutter shadow */}
          <path d="M80 34v60" />
          <path d="M74 38v54M86 38v54" opacity="0.25" />
          {/* written lines on the left page */}
          <path d="M40 50h28M40 60h30M40 70h20" opacity="0.55" />
          {/* the line waiting to be written, with its point */}
          <path d="M94 52h24M124.5 52a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0" stroke={sunrise} strokeWidth="2.5" />
          {/* ribbon */}
          <path d="M120 32v14l-4-3-4 3V33" opacity="0.55" />
        </>
      )}
    </Illustration>
  );
}
