"use client";

import type {
  RevisionDiffView,
  RevisionSummaryView,
} from "@repo/core/application/memo/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { actorLabel } from "@/components/timeline/MemoEntry";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { diffMemoRevisionsFn, rollbackMemoFn } from "../actions";
import { DiffView } from "../DiffView";
import { isRevisionDiffResult, isRollbackMemoResult } from "../schema";

export type RevisionHistoryProps = Readonly<{
  memoId: string;
  /** Ascending by `revisionNumber`; never empty. */
  revisions: readonly RevisionSummaryView[];
}>;

type Selection = Readonly<{ base: number | null; target: number | null }>;

/**
 * P-05: the history in ascending order, two-point selection (the first
 * click is the base, the second the target; clicking a chosen row again
 * un-chooses it) and "restore this content" on the base. With a single
 * revision there is nothing to compare or restore to, so neither appears.
 */
export function RevisionHistory({ memoId, revisions }: RevisionHistoryProps) {
  const router = useRouter();
  const fetchDiff = useServerFn(diffMemoRevisionsFn);
  const rollback = useServerFn(rollbackMemoFn);
  const canCompare = revisions.length > 1;
  const [selection, setSelection] = useState<Selection>({
    base: null,
    target: null,
  });
  const [diff, setDiff] = useState<RevisionDiffView | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, startDiff] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [rollingBack, startRollback] = useTransition();
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);

  const loadDiff = (base: number, target: number) =>
    startDiff(async () => {
      try {
        setDiff(
          readServerFnResult(
            await fetchDiff({
              data: {
                memoId,
                baseRevisionNumber: base,
                targetRevisionNumber: target,
              },
            }),
            isRevisionDiffResult,
            "diffMemoRevisionsFn",
          ),
        );
        setDiffError(null);
      } catch (failure) {
        setDiff(null);
        setDiffError(displayError(failure));
      }
    });

  const select = (revisionNumber: number) => {
    const { base, target } = selection;
    if (base === null) {
      setSelection({ base: revisionNumber, target: null });
      return;
    }
    if (revisionNumber === base) {
      setSelection({ base: null, target: null });
      setDiff(null);
      return;
    }
    if (revisionNumber === target) {
      setSelection({ base, target: null });
      setDiff(null);
      return;
    }
    setSelection({ base, target: revisionNumber });
    loadDiff(base, revisionNumber);
  };

  const confirmRollback = () => {
    const base = selection.base;
    if (base === null) return;
    startRollback(async () => {
      try {
        const result = readServerFnResult(
          await rollback({ data: { memoId, targetRevisionNumber: base } }),
          isRollbackMemoResult,
          "rollbackMemoFn",
        );
        if (result.result === "rolledBack") {
          // Decision J-D: back to the timeline at the memo's position.
          await router.navigate({ to: "/", search: { memo: memoId } });
          return;
        }
        setConfirming(false);
        setRollbackNotice("現在の内容は既にこのリビジョンと同じです");
        setRollbackError(null);
      } catch (failure) {
        setConfirming(false);
        setRollbackNotice(null);
        setRollbackError(displayError(failure));
      }
    });
  };

  const { base, target } = selection;
  return (
    <div className="fog-history">
      <Link to="/" className="fog-context-link">
        ← タイムラインへ戻る
      </Link>
      <div className="fog-section-heading">
        <h3>履歴</h3>
        {canCompare && (
          <span className="fog-meta">
            {base === null
              ? "比較元のリビジョンを選んでください"
              : target === null
                ? "比較先のリビジョンを選んでください"
                : `リビジョン ${base} → ${target}`}
          </span>
        )}
      </div>
      <ol className="fog-revision-list" aria-label="リビジョン一覧">
        {revisions.map((revision) => {
          const n = revision.revisionNumber;
          const body = (
            <>
              <span className="fog-revision-info">
                <span className="fog-revision-time">
                  {formatDateTime(revision.createdAt)}
                </span>
                <span className="fog-revision-meta">
                  {actorLabel(revision.actor)} · リビジョン {n}
                </span>
              </span>
              {n === base && <span className="fog-badge">比較元</span>}
              {n === target && <span className="fog-badge">比較先</span>}
            </>
          );
          return (
            <li key={n}>
              {canCompare ? (
                <button
                  type="button"
                  className="fog-revision-row"
                  aria-pressed={n === base || n === target}
                  onClick={() => select(n)}
                >
                  {body}
                </button>
              ) : (
                <div className="fog-revision-row">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {canCompare && base !== null && target !== null && (
        <section className="fog-diff-section" aria-label="差分">
          <p className="fog-diff-label">
            リビジョン {base} → リビジョン {target} の差分
          </p>
          {loadingDiff && <p role="status">差分を読み込み中…</p>}
          {diffError && (
            <p className="fog-error" role="alert">
              {diffError}
            </p>
          )}
          {diff && !loadingDiff && (
            <DiffView base={diff.base.body} target={diff.target.body} />
          )}
        </section>
      )}
      {canCompare && base !== null && (
        <div className="fog-action-row">
          <button
            type="button"
            className="fog-primary"
            onClick={() => setConfirming(true)}
          >
            この内容に戻す
          </button>
        </div>
      )}
      {rollbackNotice && (
        <p className="fog-notice" role="status">
          {rollbackNotice}
        </p>
      )}
      {rollbackError && (
        <p className="fog-error" role="alert">
          {rollbackError}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="この内容に戻しますか？"
        description={`リビジョン ${base ?? ""} と同じ内容が新しいリビジョンとして積まれます。これまでの履歴は消えません。`}
        confirmLabel="戻す"
        pending={rollingBack}
        onConfirm={confirmRollback}
        onCancel={() => {
          if (!rollingBack) setConfirming(false);
        }}
      />
    </div>
  );
}
