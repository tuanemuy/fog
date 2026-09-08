"use client";

import type {
  DocumentDiffView,
  DocumentRevisionMetaView,
} from "@repo/core/application/knowledge/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { DiffView } from "@/components/memoHistory/DiffView";
import { actorLabel } from "@/components/timeline/MemoEntry";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { diffDocumentRevisionsFn, rollbackDocumentFn } from "../actions";
import { isDocumentDiffResult, isRollbackDocumentResult } from "../schema";

export type DocumentRevisionHistoryProps = Readonly<{
  documentId: string;
  title: string;
  latestRevision: number;
  /** Ascending by `revisionNumber`; never empty. */
  revisions: readonly DocumentRevisionMetaView[];
}>;

type Selection = Readonly<{ base: number | null; target: number | null }>;

/**
 * P-10: the history ascending (who · why, when), two-point selection like
 * the memo history — with the difference (decision △-5) that the first
 * click already shows the diff against the latest revision, and the second
 * click switches it to base → target. 「この内容に戻す」 acts on the base.
 * A single revision has nothing to compare or restore to.
 */
export function DocumentRevisionHistory({
  documentId,
  title,
  latestRevision,
  revisions,
}: DocumentRevisionHistoryProps) {
  const router = useRouter();
  const fetchDiff = useServerFn(diffDocumentRevisionsFn);
  const rollback = useServerFn(rollbackDocumentFn);
  const canCompare = revisions.length > 1;
  const [selection, setSelection] = useState<Selection>({
    base: null,
    target: null,
  });
  const [diff, setDiff] = useState<DocumentDiffView | null>(null);
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
                documentId,
                baseRevisionNumber: base,
                targetRevisionNumber: target,
              },
            }),
            isDocumentDiffResult,
            "diffDocumentRevisionsFn",
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
      // Against the latest right away; the latest itself has nothing to show.
      if (revisionNumber !== latestRevision) {
        loadDiff(revisionNumber, latestRevision);
      } else {
        setDiff(null);
      }
      return;
    }
    if (revisionNumber === base) {
      setSelection({ base: null, target: null });
      setDiff(null);
      return;
    }
    if (revisionNumber === target) {
      setSelection({ base, target: null });
      if (base !== latestRevision) loadDiff(base, latestRevision);
      else setDiff(null);
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
          await rollback({ data: { documentId, revisionNumber: base } }),
          isRollbackDocumentResult,
          "rollbackDocumentFn",
        );
        if (result.changed) {
          await router.navigate({
            to: "/documents/$documentId",
            params: { documentId },
          });
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
  const shownTarget = target ?? latestRevision;
  const showDiff = canCompare && base !== null && base !== shownTarget;
  return (
    <div className="fog-history">
      <Link
        to="/documents/$documentId"
        params={{ documentId }}
        className="fog-context-link"
      >
        ← {title}
      </Link>
      <div className="fog-section-heading">
        <h3>履歴</h3>
        {canCompare && (
          <span className="fog-meta">
            {base === null
              ? "比較元のリビジョンを選んでください"
              : target === null
                ? "比較先を選ぶと二点の差分に切り替わります"
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
                  {actorLabel(revision.actor)} · {revision.changeReason} ·
                  リビジョン {n}
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
      {showDiff && (
        <section className="fog-diff-section" aria-label="差分">
          <p className="fog-diff-label">
            リビジョン {base} → リビジョン {shownTarget}
            {target === null ? "（最新）" : ""} の差分
          </p>
          {loadingDiff && <p role="status">差分を読み込み中…</p>}
          {diffError && (
            <p className="fog-error" role="alert">
              {diffError}
            </p>
          )}
          {diff && !loadingDiff && (
            <>
              {diff.base.title !== diff.target.title && (
                <p className="fog-diff-title">
                  タイトル: <del>{diff.base.title}</del> →{" "}
                  <ins>{diff.target.title}</ins>
                </p>
              )}
              <DiffView base={diff.base.body} target={diff.target.body} />
            </>
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
