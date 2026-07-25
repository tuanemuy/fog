import { createLink } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";

const TEXT_LINK =
  "rounded-sm text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

type TextLinkAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>;
};

// `className` is merged, not overwritten: the router hands an active link
// `className="active"`, which spread after a fixed `className` would strip
// the colour and the focus ring off whichever link points at the current
// page.
function TextLinkAnchor({ ref, className, ...props }: TextLinkAnchorProps) {
  return (
    <a
      ref={ref}
      className={
        className === undefined ? TEXT_LINK : `${TEXT_LINK} ${className}`
      }
      {...props}
    />
  );
}

/**
 * Inline text link (`spec/design/pages/login.html` の `.form-link`).
 *
 * Built with `createLink` so the router's typed `to` survives the wrapper —
 * the styling lives here once instead of being copied per call site.
 */
export const TextLink = createLink(TextLinkAnchor);
