import { cn } from "../../lib/utils";

/** A 24px folder whose peeking sheets grow with the number of documents inside. */
export function FolderMark({ count, className }: { count: number; className?: string }) {
  const sheets = count <= 0 ? 0 : count < 5 ? 1 : count < 20 ? 2 : 3;
  return (
    <svg
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
      data-sheets={sheets}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.25}
      viewBox="0 0 24 24"
    >
      {sheets >= 3 && <path d="M9 5.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" opacity="0.4" />}
      {sheets >= 2 && <path d="M7.5 7.5V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1.5" opacity="0.6" />}
      {sheets >= 1 && <path d="M6 9.5V7.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v2" />}
      <path d="M3 11.5V10a1.5 1.5 0 0 1 1.5-1.5H9L10.5 10h9A1.5 1.5 0 0 1 21 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </svg>
  );
}
