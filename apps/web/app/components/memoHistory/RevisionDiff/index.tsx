"use client";

import { type ReactNode, useId } from "react";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Sk } from "@/components/ui/Sk";

export type RevisionDiffProps = Readonly<{
  /** 「<base> → <target> の差分」, naming the region. */
  label: string;
  loading: boolean;
  /** Why the two versions could not be fetched; offers 「再試行」. */
  error: string | null;
  onRetry: () => void;
  /** The diff itself (`DiffView`), drawn once it is neither loading nor failed. */
  children: ReactNode;
}>;

/**
 * The difference between the two picked versions, under the list
 * (`.diff-label` + `.diff-view` in `spec/design/pages/memo-history.html`).
 * While the two snapshots load, the box stands in with `Sk` lines; a failed
 * fetch stays in the region with a retry.
 */
export function RevisionDiff({
  label,
  loading,
  error,
  onRetry,
  children,
}: RevisionDiffProps) {
  const labelId = useId();
  return (
    <section aria-labelledby={labelId} className="mt-section">
      <p
        id={labelId}
        className="font-base text-sm font-semibold leading-tight text-neutral-600 tabular-nums next-sibling:mt-lg"
      >
        {label}
      </p>
      {loading ? (
        <div role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">差分を読み込み中</span>
          <div className="rounded-md border border-neutral-100 bg-bg-card p-lg font-base text-sm leading-normal">
            <p className="py-xs">
              <Sk>変更前の行がここに入ります</Sk>
            </p>
            <p className="py-xs">
              <Sk>変更後の行がここに入ります</Sk>
            </p>
          </div>
        </div>
      ) : error !== null ? (
        <InlineAlert tone="error" retry={{ label: "再試行", onRetry }}>
          {error}
        </InlineAlert>
      ) : (
        children
      )}
    </section>
  );
}
