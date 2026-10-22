import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";
import type { LearningItem } from "./learning-types";

/**
 * The first page of suggestions waiting for approval from one source. Home,
 * the sidebar count, and the Review learning header share the nightly one so
 * they fetch once. The inbox on the Review learning page pages through the
 * same list with an infinite query under `["learning", kind, status]`; a
 * plain query must never reuse that key, because the cached shapes differ
 * and the page would crash reading `pages`.
 */
export function pendingSuggestionsQuery(kind: LearningItem["kind"] = "dreaming") {
  return queryOptions({
    queryKey: ["learning", "summary", kind, "pending"],
    queryFn: ({ signal }) => api.learningList({ kind, status: "pending" }, signal),
  });
}
