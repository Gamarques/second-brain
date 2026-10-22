import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders overlay content as a direct child of `document.body`.
 *
 * A `position: fixed` overlay resolves against the viewport only while no
 * ancestor establishes a containing block. Any filling `transform`, `filter`,
 * or `will-change` animation on an ancestor silently changes that, which
 * clips the overlay to the ancestor's box. Route content is animated, so
 * every modal surface must escape the tree it was authored in.
 */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
