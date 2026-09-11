"use client";

import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";

type RowAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style" | "children"
> &
  Readonly<{
    /** The row's text: title, then its meta line. */
    children?: ReactNode;
  }>;

// The only negative margin in the design (tokens.md「スペーシング」): the hover
// and focus surface reaches `--space-md` past the text column on both sides,
// and the padding brings the text back onto it.
const ROW_LINK_CLASS =
  "-mx-md flex items-center gap-md rounded-md px-md py-row font-base text-base leading-normal text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

// See `ButtonLink`: the router's merged `className` / `style` are overwritten.
function RowAnchor({ children, ...rest }: RowAnchorProps) {
  return (
    <a {...rest} className={ROW_LINK_CLASS} style={undefined}>
      <span className="min-w-0 flex-1">{children}</span>
      <span className="flex shrink-0 text-primary">
        <Icon name="jump" size="md" />
      </span>
    </a>
  );
}

/**
 * A row that is one link as a whole (`spec/design/pages/document.html`): the
 * whole row is the hover surface and the focus ring, and it ends in the jump
 * arrow. Takes `Link`'s typed props; the children are the row's text. Put it
 * in a `RowList` item — the hairline between rows is the list's.
 */
export const RowLink = createLink(RowAnchor);
