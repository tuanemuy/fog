import { createLink } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";

const TEXT_LINK =
  "rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

type TextLinkAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>;
};

function TextLinkAnchor({ ref, ...props }: TextLinkAnchorProps) {
  return <a ref={ref} className={TEXT_LINK} {...props} />;
}

/**
 * Inline text link (`spec/design/pages/login.html` の `.form-link`).
 *
 * Built with `createLink` so the router's typed `to` survives the wrapper —
 * the styling lives here once instead of being copied per call site.
 */
export const TextLink = createLink(TextLinkAnchor);
