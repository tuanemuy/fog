"use client";

import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "@/components/ui/Icon";

// `spec/design/pages/topics.html` / `topic-detail.html`, `.add-item`: the row
// that ends a list and creates the next item. Like `RowLink` it is an
// interactive row, so its hover and focus surface bleeds `--space-md` past
// the text column and the padding brings the text back onto it. It sits in
// the list's last `<li>`, so the hairline above it is `RowList`'s — and there
// is none when the list holds nothing else.
const ADD_ROW_BOX =
  "flex cursor-pointer items-center gap-md rounded-md px-md py-row text-left font-base text-base font-medium leading-normal text-primary-dark transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

function Body({ children }: Readonly<{ children: string }>) {
  return (
    <>
      <span className="flex shrink-0 text-primary">
        <Icon name="plus" size="xs" />
      </span>
      {children}
    </>
  );
}

type AddRowButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "style" | "children" | "type"
> &
  Readonly<{ children: string }>;

/** An add row that opens a form in its place (新しいトピック). */
export function AddRowButton({ children, ...rest }: AddRowButtonProps) {
  // A negative margin does not widen a button the way it widens a block
  // link, so the wrapper takes the bleed and the button fills it.
  return (
    <div className="-mx-md">
      <button {...rest} type="button" className={`w-full ${ADD_ROW_BOX}`}>
        <Body>{children}</Body>
      </button>
    </div>
  );
}

type AddRowAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style" | "children"
> &
  Readonly<{ children: string }>;

// The router's merged `className` / `style` are overwritten, as `RowLink`'s.
function AddRowAnchor({ children, ...rest }: AddRowAnchorProps) {
  return (
    <a {...rest} className={`-mx-md ${ADD_ROW_BOX}`} style={undefined}>
      <Body>{children}</Body>
    </a>
  );
}

/** An add row that leads to a creation screen (新しいドキュメント). */
export const AddRowLink = createLink(AddRowAnchor);
