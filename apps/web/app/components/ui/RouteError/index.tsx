"use client";

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePageHeadingOwner } from "@/components/ui/PageHeading";

/**
 * The route error and the failed load of a streamed fragment
 * (`spec/design/pages/timeline.html`, 状態の例): 「読み込めませんでした」 and
 * 「再試行」, drawn where the screen was. The router's default error
 * component (ADR-009 of Issue #22); the layouts wrap it in the auth sheet.
 *
 * The sentence is fixed: nothing of the error — a message a layer wrote, a
 * value that came off the wire — reaches the page. Logging is the router's
 * (`defaultOnCatch`).
 *
 * Retry reruns the loaders with `router.invalidate()`. The error boundary
 * resets on its own once that load settles, since the router keys it on the
 * load, so a fragment that failed while streaming is rendered afresh from
 * the new promise.
 */
export function RouteError() {
  const router = useRouter();
  const owner = usePageHeadingOwner();
  // Plain state rather than `useTransition`: in the browser, a transition
  // around `router.invalidate()` kept its pending flag up after a retry that
  // failed again had settled, leaving the button disabled for good.
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert">
      <EmptyState
        message="読み込めませんでした"
        asPageHeading={owner === "screen"}
        action={
          <Button
            variant="fill"
            disabled={retrying}
            onClick={() => void retry()}
          >
            再試行
          </Button>
        }
      />
    </div>
  );
}
