"use client";

import type {
  DocumentDiffView,
  DocumentRevisionMetaView,
} from "@repo/core/application/knowledge/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { DiffView } from "@/components/memoHistory/DiffView";
import { RevisionDiff } from "@/components/memoHistory/RevisionDiff";
import {
  HISTORY_SECTION_CLASS,
  NO_SELECTION,
  RevisionList,
  type RevisionSelection,
} from "@/components/memoHistory/RevisionList";
import { RollbackControl } from "@/components/memoHistory/RollbackControl";
import { actorLabel } from "@/components/timeline/MemoEntry";
import { SHEET_TITLE_CLASS } from "@/components/ui/SheetTitle";
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

/**
 * P-10: the document's title as the page's `h1`, then the history in the
 * memo history's shape (who · why, when), two-point selection like the memo
 * history — with the difference (decision △-5) that the first click already
 * shows the diff against the latest revision, and the second click switches
 * it to base → target. 「この内容に戻す」 acts on the base. A single revision
 * has nothing to compare or restore to.
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
  const [selection, setSelection] = useState<RevisionSelection>(NO_SELECTION);
  const [diff, setDiff] = useState<DocumentDiffView | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, startDiff] = useTransition();

  const timeOf = (revisionNumber: number) => {
    const found = revisions.find((r) => r.revisionNumber === revisionNumber);
    return found === undefined ? "" : formatDateTime(found.createdAt);
  };

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
      setSelection(NO_SELECTION);
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

  const rollbackToBase = async (base: number) => {
    const result = readServerFnResult(
      await rollback({ data: { documentId, revisionNumber: base } }),
      isRollbackDocumentResult,
      "rollbackDocumentFn",
    );
    if (!result.changed) return "unchanged" as const;
    // The document screen is cached with the body from before the rollback;
    // invalidating before the navigation is what makes it show the new one.
    await router.invalidate();
    await router.navigate({
      to: "/documents/$documentId",
      params: { documentId },
    });
    return "rolledBack" as const;
  };

  const { base, target } = selection;
  const shownTarget = target ?? latestRevision;
  const showDiff = canCompare && base !== null && base !== shownTarget;
  return (
    <div>
      <h1 className={SHEET_TITLE_CLASS}>{title}</h1>
      <section className={HISTORY_SECTION_CLASS}>
        <RevisionList
          revisions={revisions.map((revision) => ({
            revisionNumber: revision.revisionNumber,
            createdAt: revision.createdAt,
            meta: `${actorLabel(revision.actor)} · ${revision.changeReason}`,
          }))}
          selection={selection}
          onSelect={canCompare ? select : null}
        />
        {showDiff && (
          <RevisionDiff
            label={`${timeOf(base)} → ${timeOf(shownTarget)}${target === null ? "（最新）" : ""} の差分`}
            loading={loadingDiff}
            error={diffError}
            onRetry={() => loadDiff(base, shownTarget)}
          >
            {diff && (
              <>
                {diff.base.title !== diff.target.title && (
                  <p className="font-base text-sm leading-normal text-neutral-600 wrap-anywhere next-sibling:mt-md">
                    タイトル:{" "}
                    <del className="text-error-dark">{diff.base.title}</del>
                    {" → "}
                    <ins className="text-success-dark no-underline">
                      {diff.target.title}
                    </ins>
                  </p>
                )}
                <DiffView base={diff.base.body} target={diff.target.body} />
              </>
            )}
          </RevisionDiff>
        )}
        {canCompare && base !== null && (
          <RollbackControl
            key={base}
            baseTime={timeOf(base)}
            rollback={() => rollbackToBase(base)}
          />
        )}
      </section>
    </div>
  );
}
