import { Illustration, type IllustrationProps } from "./illustration";

/** Night giving way: a thin crescent, a horizon, and the sun coming up in the sunrise colours. */
export function EmptyReviewsIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          {/* the sun, half up */}
          <path d="M80 84a16 16 0 0 1 32 0z" fill={sunrise} stroke="none" />
          <path d="M96 60v-8M78 66l-6-6M114 66l6-6" opacity="0.6" />
          {/* horizon and distant hills */}
          <path d="M16 84h128" />
          <path d="M16 98q40-12 80 0t48 0" opacity="0.35" />
          {/* last of the night */}
          <path d="M46 30a13 13 0 1 0 12 19a10 10 0 1 1-12-19z" opacity="0.7" />
          <circle cx="30" cy="52" fill="currentColor" r="1" stroke="none" opacity="0.5" />
          <circle cx="64" cy="24" fill="currentColor" r="1" stroke="none" opacity="0.5" />
        </>
      )}
    </Illustration>
  );
}
