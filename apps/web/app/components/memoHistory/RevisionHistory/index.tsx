"use client";

import type {
  RevisionDiffView,
  RevisionSummaryView,
} from "@repo/core/application/memo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { actorLabel } from "@/components/timeline/MemoEntry";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { diffMemoRevisionsFn, rollbackMemoFn } from "../actions";
import { DiffView } from "../DiffView";
import { RevisionDiff } from "../RevisionDiff";
import {
  NO_SELECTION,
  RevisionList,
  type RevisionSelection,
} from "../RevisionList";
import { RollbackControl } from "../RollbackControl";
import { isRevisionDiffResult, isRollbackMemoResult } from "../schema";

export type RevisionHistoryProps = Readonly<{
  memoId: string;
  /** Ascending by `revisionNumber`; never empty. */
  revisions: readonly RevisionSummaryView[];
}>;

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
  const [selection, setSelection] = useState<RevisionSelection>(NO_SELECTION);
  const [diff, setDiff] = useState<RevisionDiffView | null>(null);
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
      setSelection(NO_SELECTION);
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

  const rollbackToBase = async (base: number) => {
    const result = readServerFnResult(
      await rollback({ data: { memoId, targetRevisionNumber: base } }),
      isRollbackMemoResult,
      "rollbackMemoFn",
    );
    if (result.result === "unchanged") return "unchanged" as const;
    // Decision J-D: back to the timeline at the memo's position.
    await router.navigate({ to: "/", search: { memo: memoId } });
    return "rolledBack" as const;
  };

  const { base, target } = selection;
  return (
    <div>
      <RevisionList
        revisions={revisions.map((revision) => ({
          revisionNumber: revision.revisionNumber,
          createdAt: revision.createdAt,
          meta: actorLabel(revision.actor),
        }))}
        selection={selection}
        onSelect={canCompare ? select : null}
      />
      {canCompare && base !== null && target !== null && (
        <RevisionDiff
          label={`${timeOf(base)} → ${timeOf(target)} の差分`}
          loading={loadingDiff}
          error={diffError}
          onRetry={() => loadDiff(base, target)}
        >
          {diff && <DiffView base={diff.base.body} target={diff.target.body} />}
        </RevisionDiff>
      )}
      {canCompare && base !== null && (
        <RollbackControl
          key={base}
          baseTime={timeOf(base)}
          rollback={() => rollbackToBase(base)}
        />
      )}
    </div>
  );
}
