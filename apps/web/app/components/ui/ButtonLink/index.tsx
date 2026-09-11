"use client";

import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";
import {
  type ButtonVariant,
  buttonClassName,
} from "@/components/ui/Button/styles";

type ButtonAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style"
> &
  Readonly<{ variant: ButtonVariant }>;

// The router merges `className` / `style` into what it hands the anchor; both
// are written after the spread so that nothing but the step reaches it.
function ButtonAnchor({ variant, ...rest }: ButtonAnchorProps) {
  return <a {...rest} className={buttonClassName(variant)} style={undefined} />;
}

/**
 * `Button`'s look on a router link. Takes `Link`'s typed props (`to`,
 * `params`, `search`, …) plus the button step. `className` and `style` are
 * not accepted — neither directly nor through `activeProps` /
 * `inactiveProps`, which `createLink` types from this anchor's own props.
 */
export const ButtonLink = createLink(ButtonAnchor);
