import type { ComponentPropsWithRef } from "react";
import { Icon, type IconName, type IconSize } from "@/components/ui/Icon";
import {
  type IconButtonPlacement,
  type IconButtonTone,
  iconButtonClassName,
} from "./styles";

export type { IconButtonPlacement, IconButtonTone } from "./styles";

export type IconButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "style" | "children" | "aria-label" | "aria-labelledby"
> &
  Readonly<{
    icon: IconName;
    /** The accessible name. There is no visible text, so it is required. */
    label: string;
    size: IconSize;
    placement: IconButtonPlacement;
    tone?: IconButtonTone;
  }>;

/**
 * An icon-only button: one glyph from `Icon`'s closed set, named by the
 * required `label`. `className`, `style` and children are not accepted; the
 * look is `placement` × `tone`. `type` defaults to `"button"`. The link-shaped
 * twin is `IconButtonLink`.
 */
export function IconButton({
  icon,
  label,
  size,
  placement,
  tone = "neutral",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={iconButtonClassName(placement, tone)}
      style={undefined}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
