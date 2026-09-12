"use client";

import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";
import { Icon, type IconName, type IconSize } from "@/components/ui/Icon";
import {
  type IconButtonPlacement,
  type IconButtonTone,
  iconButtonClassName,
} from "@/components/ui/IconButton/styles";

type IconAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style" | "children" | "aria-label" | "aria-labelledby"
> &
  Readonly<{
    icon: IconName;
    label: string;
    size: IconSize;
    placement: IconButtonPlacement;
    tone?: IconButtonTone;
    children?: never;
  }>;

// See `ButtonLink`: the router's merged `className` / `style` are overwritten.
function IconAnchor({
  icon,
  label,
  size,
  placement,
  tone = "neutral",
  href,
  ...rest
}: IconAnchorProps) {
  return (
    <a
      {...rest}
      href={href}
      aria-label={label}
      className={iconButtonClassName(placement, tone)}
      style={undefined}
    >
      <Icon name={icon} size={size} />
    </a>
  );
}

/**
 * `IconButton`'s look on a router link — a header action that navigates
 * (edit, history). Takes `Link`'s typed props plus the icon, the required
 * `label`, `placement` and `tone`; no `className`, `style` or children.
 */
export const IconButtonLink = createLink(IconAnchor);
