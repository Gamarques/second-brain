import { Illustration, type IllustrationProps } from "./illustration";

/** A quiet rail with empty slots and one lit piece waiting at the start of the line. */
export function EmptyJobsIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M24 74h112" />
          <path d="M40 74v6M76 74v6M112 74v6" opacity="0.4" />
          <rect height="16" opacity="0.45" rx="3" strokeDasharray="2 3" width="22" x="54" y="54" />
          <rect height="16" opacity="0.45" rx="3" strokeDasharray="2 3" width="22" x="86" y="54" />
          <rect height="16" opacity="0.45" rx="3" strokeDasharray="2 3" width="22" x="118" y="54" />
          <circle cx="34" cy="62" fill={sunrise} r="7" stroke="none" />
          <path d="M20 46c4-4 8-6 14-6s10 2 14 6" opacity="0.35" />
        </>
      )}
    </Illustration>
  );
}
