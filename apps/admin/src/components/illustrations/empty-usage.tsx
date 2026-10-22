import { Illustration, type IllustrationProps } from "./illustration";

/** Four bars on a baseline, the tallest lit; the chart is ready for its first requests. */
export function EmptyUsageIllustration(props: IllustrationProps) {
  return (
    <Illustration {...props}>
      {(sunrise) => (
        <>
          <path d="M28 92h104" />
          <rect height="30" rx="2" width="16" x="36" y="62" />
          <rect height="44" rx="2" width="16" x="60" y="48" />
          <rect height="22" rx="2" width="16" x="84" y="70" />
          <rect fill={sunrise} height="56" rx="2" stroke="none" width="16" x="108" y="36" />
          <path d="M28 40h104" opacity="0.2" strokeDasharray="2 4" />
          <path d="M28 66h104" opacity="0.2" strokeDasharray="2 4" />
        </>
      )}
    </Illustration>
  );
}
