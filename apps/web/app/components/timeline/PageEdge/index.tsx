"use client";

import type { Ref } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";

export type PageEdgeProps = Readonly<{
  /** The sentinel the list watches to pull in the next page. */
  sentinelRef: Ref<HTMLDivElement>;
  loading: boolean;
  /** 「過去のメモを読み込み中」 / 「新しいメモを読み込み中」 */
  loadingLabel: string;
  failed: boolean;
  onRetry: () => void;
}>;

/**
 * One end of the timeline while there is more behind it
 * (`spec/design/pages/timeline.html`, `.loading-more` and 状態の例「読み込み
 * 失敗 — 過去のメモの追加読み込み」): the sentinel with the spinner while
 * the next page loads, or, when it failed, one sentence and 「再試行」 in its
 * place, the memos already loaded kept above it. The status region is
 * mounted empty so it announces the loading when it starts.
 */
export function PageEdge({
  sentinelRef,
  loading,
  loadingLabel,
  failed,
  onRetry,
}: PageEdgeProps) {
  if (failed) {
    return (
      <div role="alert">
        <EmptyState
          message="読み込めませんでした"
          action={
            <Button variant="text" onClick={onRetry}>
              再試行
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div
      ref={sentinelRef}
      role="status"
      className="flex items-center justify-center gap-sm pt-lg pb-sm font-base text-xs font-medium leading-tight tracking-label text-neutral-400"
    >
      {loading ? (
        <>
          <Icon name="spinner" size="xs" />
          {loadingLabel}
        </>
      ) : null}
    </div>
  );
}
