"use client";

import { ButtonLink } from "@/components/ui/ButtonLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePageHeadingOwner } from "@/components/ui/PageHeading";

/**
 * The 404 (`spec/design/pages/timeline.html` / `login.html`, 状態の例):
 * 「ページが見つかりません」 and the way back to the timeline. The router's
 * default not-found component — in the app shell's
 * sheet for a screen under `_app` that answers not found, on the auth sheet
 * for a URL no route serves.
 */
export function NotFound() {
  const owner = usePageHeadingOwner();
  return (
    <EmptyState
      message="ページが見つかりません"
      asPageHeading={owner === "screen"}
      action={
        <ButtonLink variant="fill" to="/">
          タイムラインへ
        </ButtonLink>
      }
    />
  );
}
