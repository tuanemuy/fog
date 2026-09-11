import type { ComponentPropsWithRef } from "react";
import {
  type ButtonVariant,
  buttonClassName,
} from "@/components/ui/Button/styles";

export type ButtonAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style"
> &
  Readonly<{ variant: ButtonVariant }>;

/**
 * `Button`'s look on a plain anchor: for the destinations the router does
 * not serve — the request Worker's own handlers, which answer a redirect
 * chain rather than a route (`/auth/sso/:provider/start` on P-01 / P-02 and
 * P-13). A route goes through `ButtonLink` instead, which is built on this
 * one and keeps the typed props.
 *
 * The look is the step and nothing else: `className` and `style` are not
 * accepted, and are overwritten if forced through — which is also what keeps
 * `ButtonLink`'s `activeProps` / `inactiveProps` from reaching the anchor.
 */
export function ButtonAnchor({ variant, ...rest }: ButtonAnchorProps) {
  return <a {...rest} className={buttonClassName(variant)} style={undefined} />;
}
