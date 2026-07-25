import { createLink } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";

type BrandLinkAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>;
};

// The router publishes `aria-current="page"` on every active link, and the
// wordmark points at `/` — on the timeline that announces a second "current
// page" beside the nav item that actually means it. `activeProps` cannot
// suppress it (the router spreads `aria-current` after `activeProps`), so it
// is dropped here.
function BrandLinkAnchor({
  ref,
  "aria-current": _ariaCurrent,
  ...props
}: BrandLinkAnchorProps) {
  return <a ref={ref} {...props} />;
}

/**
 * The wordmark's link home. Carries no current-page semantics: the global
 * nav is the one place the current screen is announced.
 */
export const BrandLink = createLink(BrandLinkAnchor);
