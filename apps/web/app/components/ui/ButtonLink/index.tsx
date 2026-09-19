"use client";

import { createLink } from "@tanstack/react-router";
import { ButtonAnchor } from "@/components/ui/ButtonAnchor";

/**
 * `Button`'s look on a router link. Takes `Link`'s typed props (`to`,
 * `params`, `search`, …) plus the button step. `className` and `style` are
 * not accepted — neither directly nor through `activeProps` /
 * `inactiveProps`, which `createLink` types from `ButtonAnchor`'s own props,
 * and which `ButtonAnchor` overwrites in any case.
 */
export const ButtonLink = createLink(ButtonAnchor);
