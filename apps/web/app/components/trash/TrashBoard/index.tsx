"use client";

import type {
  TrashItemView,
  TrashListView,
} from "@repo/core/application/trash/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { LoadingRow } from "@/components/ui/LoadingRow";
import { Row, type RowLevel } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";
import { RowList } from "@/components/ui/RowList";
import { useToast } from "@/components/ui/Toast";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import {
  emptyTrashFn,
  hardDeleteTrashItemFn,
  listTrashFn,
  restoreDocumentFn,
  restoreMemoFn,
  restoreTopicFn,
} from "../actions";
import {
  type RestoreDestination,
  RestoreDestinationDialog,
  type RestoreDestinationError,
} from "../RestoreDestinationDialog";
import {
  isEmptyTrashResult,
  isHardDeleteResult,
  isRestoreDocumentResult,
  isRestoreMemoResult,
  isRestoreTopicResult,
  isTrashList,
  TRASH_PAGE_LIMIT,
} from "../schema";
import {
  KindPill,
  RemainingDays,
  RowStatus,
  TrashHeader,
  TrashRowActions,
  TrashTags,
} from "../TrashParts";

const DAY_MS = 86_400_000;

/** Days left until the stored deadline, rounded up; a passed one is imminent (decision △-3). */
export function remainingLabel(expiresAt: Date, now: Date): string {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  return days <= 0 ? "まもなく削除" : `残り${days}日`;
}

const KIND_LABELS = {
  memo: "メモ",
  document: "ドキュメント",
  topic: "トピック",
} as const;

function titleOf(item: TrashItemView): string {
  switch (item.kind) {
    case "memo":
      return item.excerpt;
    case "document":
      return item.title;
    case "topic":
      return item.name;
  }
}

type Group = Readonly<{
  item: TrashItemView;
  children: readonly TrashItemView[];
}>;

/**
 * Groups the flat page: a document trashed with a topic that is on the same
 * page sits under it, and the indent is the set relation. One whose topic is
 * not loaded stays a row of its own (decision △-2).
 */
export function groupRows(items: readonly TrashItemView[]): Group[] {
  const topics = new Set(
    items.filter((i) => i.kind === "topic").map((i) => i.id),
  );
  const rows: Group[] = [];
  const childrenOf = new Map<string, TrashItemView[]>();
  for (const item of items) {
    if (
      item.kind === "document" &&
      item.deletedWithTopic &&
      topics.has(item.topicId)
    ) {
      const list = childrenOf.get(item.topicId) ?? [];
      list.push(item);
      childrenOf.set(item.topicId, list);
    }
  }
  for (const item of items) {
    if (
      item.kind === "document" &&
      item.deletedWithTopic &&
      topics.has(item.topicId)
    )
      continue;
    rows.push({
      item,
      children: item.kind === "topic" ? (childrenOf.get(item.id) ?? []) : [],
    });
  }
  return rows;
}

type RowFailure = Readonly<{
  key: string;
  message: string;
  retry: () => void;
  retryLabel: string;
}>;

/** What a row action left behind: the rows it took away, and the toast to raise. */
type Outcome = Readonly<{ gone: readonly string[]; toast: string | null }>;

const NOTHING_DONE: Outcome = { gone: [], toast: null };

// Failures that belong to the list rather than to one row: 空にする, and a
// row that vanished under this tab (its row is already gone).
const LIST_FAILURE = "list";
type Pending =
  | Readonly<{
      kind: "confirmSet";
      item: TrashItemView;
      topicName: string;
      /** The set's size, when the topic is on the loaded page. */
      documentCount: number | null;
    }>
  | Readonly<{
      kind: "destination";
      item: TrashItemView;
      error: RestoreDestinationError | null;
    }>
  | Readonly<{ kind: "hardDelete"; item: TrashItemView; children: number }>
  | Readonly<{ kind: "empty" }>;

const keyOf = (item: TrashItemView) => `${item.kind}:${item.id}`;

const HARD_DELETE_TEXT = "履歴ごと消え、元に戻せません。";

/**
 * P-12, the owner of the list: restore, hard delete and empty all change
 * membership, so the rows are removed here optimistically and put back on a
 * failure with the message and a retry under the row. A row being acted on
 * is busy, says what is in flight in place of its days left, and has its
 * buttons disabled (P-12 状態「操作中」). A success is a toast.
 */
export function TrashBoard({ initial }: { initial: TrashListView }) {
  const router = useRouter();
  const toast = useToast();
  const restoreMemo = useServerFn(restoreMemoFn);
  const restoreDocument = useServerFn(restoreDocumentFn);
  const restoreTopic = useServerFn(restoreTopicFn);
  const hardDelete = useServerFn(hardDeleteTrashItemFn);
  const empty = useServerFn(emptyTrashFn);
  const listMore = useServerFn(listTrashFn);

  const [extra, setExtra] = useState<readonly TrashItemView[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(initial.page);
  const [totalCount, setTotalCount] = useState(initial.totalCount);
  // `router.invalidate()` hands in a fresh page: the local view re-bases on it.
  const [seed, setSeed] = useState(initial);
  if (seed !== initial) {
    setSeed(initial);
    setExtra([]);
    setRemoved(new Set());
    setPage(initial.page);
    setTotalCount(initial.totalCount);
  }
  const base = [...initial.items, ...extra].filter(
    (i) => !removed.has(keyOf(i)),
  );
  // Row key → what is in flight on it (「復元中…」).
  const [busy, markBusy] = useOptimistic<
    ReadonlyMap<string, string>,
    readonly [string, string]
  >(new Map(), (current, [key, label]) => new Map([...current, [key, label]]));
  const [, startAction] = useTransition();
  const [pendingDialog, setPendingDialog] = useState<Pending | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [failure, setFailure] = useState<RowFailure | null>(null);
  const [loadingMore, startMore] = useTransition();
  const [moreError, setMoreError] = useState<string | null>(null);
  const now = new Date();

  const dropRows = (keys: readonly string[]) =>
    setRemoved((current) => new Set([...current, ...keys]));

  const settle = async () => {
    await router.invalidate();
  };

  const reload = () => {
    setFailure(null);
    startAction(settle);
  };

  /** Runs one row action optimistically; on a rejection the row returns with its message. */
  const act = (
    item: TrashItemView,
    label: "復元" | "削除",
    run: () => Promise<Outcome>,
  ) => {
    const key = keyOf(item);
    setFailure(null);
    startAction(async () => {
      markBusy([key, `${label}中…`]);
      try {
        const outcome = await run();
        dropRows(outcome.gone);
        setTotalCount((n) => Math.max(0, n - outcome.gone.length));
        if (outcome.toast !== null) toast(outcome.toast);
        await settle();
      } catch (error) {
        const serialized = toDisplayError(error);
        if (serialized.kind === "notFound") {
          // The row left the trash elsewhere — hard-deleted in another tab
          // or by the purge job, or restored there — so this tab cannot tell
          // which. Say it failed, name both outcomes, and resync the list.
          dropRows([key]);
          setFailure({
            key: LIST_FAILURE,
            message: `「${titleOf(item)}」はゴミ箱に見つかりません。完全に削除されたか、別の画面で復元されています`,
            retry: reload,
            retryLabel: "一覧を読み直す",
          });
          await settle();
          return;
        }
        setFailure({
          key,
          message: `${label}できませんでした: ${displayError(error)}`,
          retry: () => act(item, label, run),
          retryLabel: "リトライ",
        });
      }
    });
  };

  const setKeys = (item: TrashItemView, restoredTopicId: string | null) => {
    const keys = [keyOf(item)];
    if (item.kind === "topic") {
      for (const id of item.setDocumentIds) keys.push(`document:${id}`);
    }
    if (restoredTopicId !== null) {
      keys.push(`topic:${restoredTopicId}`);
      for (const other of base) {
        if (
          other.kind === "document" &&
          other.deletedWithTopic &&
          other.topicId === restoredTopicId
        ) {
          keys.push(keyOf(other));
        }
      }
    }
    return [...new Set(keys)];
  };

  const setSizeOf = (topicId: string): number | null => {
    const topic = base.find((i) => i.kind === "topic" && i.id === topicId);
    return topic?.kind === "topic" ? topic.setDocumentIds.length : null;
  };

  const restore = (item: TrashItemView) => {
    if (item.kind === "memo") {
      act(item, "復元", async () => {
        readServerFnResult(
          await restoreMemo({ data: { memoId: item.id } }),
          isRestoreMemoResult,
          "restoreMemoFn",
        );
        return { gone: [keyOf(item)], toast: "メモを復元しました" };
      });
      return;
    }
    if (item.kind === "topic") {
      act(item, "復元", async () => {
        readServerFnResult(
          await restoreTopic({ data: { topicId: item.id } }),
          isRestoreTopicResult,
          "restoreTopicFn",
        );
        return { gone: setKeys(item, null), toast: "トピックを復元しました" };
      });
      return;
    }
    restoreDocumentWith(item, {});
  };

  const restoreDocumentWith = (
    item: Extract<TrashItemView, { kind: "document" }>,
    options: { confirmSetRestore?: boolean; destination?: RestoreDestination },
  ) => {
    act(item, "復元", async () => {
      const result = readServerFnResult(
        await restoreDocument({
          data: {
            documentId: item.id,
            ...(options.confirmSetRestore === undefined
              ? {}
              : { confirmSetRestore: options.confirmSetRestore }),
            ...(options.destination === undefined
              ? {}
              : { destination: options.destination }),
          },
        }),
        isRestoreDocumentResult,
        "restoreDocumentFn",
      );
      setDialogBusy(false);
      switch (result.result) {
        case "restored":
          setPendingDialog(null);
          return {
            gone: setKeys(item, result.restoredTopicId),
            toast:
              options.confirmSetRestore === true
                ? "トピックごと復元しました"
                : "ドキュメントを復元しました",
          };
        case "setRestoreConfirmationRequired":
          setPendingDialog({
            kind: "confirmSet",
            item,
            topicName: result.topicName,
            documentCount: setSizeOf(result.topicId),
          });
          return NOTHING_DONE;
        case "destinationSelectionRequired":
          setPendingDialog({ kind: "destination", item, error: null });
          return NOTHING_DONE;
      }
    });
  };

  const chooseDestination = (destination: RestoreDestination) => {
    if (
      pendingDialog?.kind !== "destination" ||
      pendingDialog.item.kind !== "document"
    )
      return;
    const item = pendingDialog.item;
    setDialogBusy(true);
    setFailure(null);
    startAction(async () => {
      try {
        const result = readServerFnResult(
          await restoreDocument({ data: { documentId: item.id, destination } }),
          isRestoreDocumentResult,
          "restoreDocumentFn",
        );
        setDialogBusy(false);
        if (result.result === "restored") {
          setPendingDialog(null);
          dropRows(setKeys(item, result.restoredTopicId));
          setTotalCount((n) => Math.max(0, n - 1));
          toast("ドキュメントを復元しました");
          await settle();
        } else if (result.result === "setRestoreConfirmationRequired") {
          setPendingDialog({
            kind: "confirmSet",
            item,
            topicName: result.topicName,
            documentCount: setSizeOf(result.topicId),
          });
        } else {
          setPendingDialog({ kind: "destination", item, error: null });
        }
      } catch (error) {
        setDialogBusy(false);
        const serialized = toDisplayError(error);
        setPendingDialog({
          kind: "destination",
          item,
          error:
            serialized.kind === "notFound"
              ? {
                  message: "そのトピックは選べません。候補を読み直してください",
                  stale: true,
                }
              : { message: displayError(error), stale: false },
        });
      }
    });
  };

  const confirmHardDelete = () => {
    if (pendingDialog?.kind !== "hardDelete") return;
    const item = pendingDialog.item;
    setPendingDialog(null);
    act(item, "削除", async () => {
      readServerFnResult(
        await hardDelete({ data: { kind: item.kind, id: item.id } }),
        isHardDeleteResult,
        "hardDeleteTrashItemFn",
      );
      return { gone: setKeys(item, null), toast: "完全に削除しました" };
    });
  };

  // The confirmation stays up while the trash empties — it is the one place
  // the wait is shown, and closing it first would leave the screen unchanged
  // with nothing running on it.
  const confirmEmpty = () => {
    setFailure(null);
    setDialogBusy(true);
    startAction(async () => {
      try {
        const result = readServerFnResult(
          await empty({}),
          isEmptyTrashResult,
          "emptyTrashFn",
        );
        setDialogBusy(false);
        setPendingDialog(null);
        // Mixed outcomes split: what was erased is a
        // toast, what was not stays on the list with its retry.
        if (result.failedCount > 0) {
          if (result.deletedCount > 0) {
            toast(`${result.deletedCount}件を完全に削除しました`);
          }
          setFailure({
            key: LIST_FAILURE,
            message: `${result.failedCount}件は削除できませんでした`,
            retry: confirmEmpty,
            retryLabel: "再試行",
          });
        } else {
          toast("ゴミ箱を空にしました");
        }
        setTotalCount((n) => Math.max(0, n - result.deletedCount));
        await settle();
      } catch (error) {
        setDialogBusy(false);
        setPendingDialog(null);
        setFailure({
          key: LIST_FAILURE,
          message: `空にできませんでした: ${displayError(error)}`,
          retry: confirmEmpty,
          retryLabel: "再試行",
        });
      }
    });
  };

  const loadMore = () => {
    setMoreError(null);
    startMore(async () => {
      try {
        const next = readServerFnResult(
          await listMore({ data: { page: page + 1, limit: TRASH_PAGE_LIMIT } }),
          isTrashList,
          "listTrashFn",
        );
        setExtra((current) => [...current, ...next.items]);
        setPage(next.page);
        setTotalCount(next.totalCount);
      } catch (error) {
        setMoreError(`続きを読み込めませんでした: ${displayError(error)}`);
      }
    });
  };

  const rows = groupRows(base);
  const loaded = initial.items.length + extra.length;
  const listFailure =
    failure !== null && failure.key === LIST_FAILURE ? failure : null;
  const rowFailure = (item: TrashItemView) =>
    failure !== null && failure.key === keyOf(item) ? failure : null;
  const askHardDelete = (item: TrashItemView) =>
    setPendingDialog({
      kind: "hardDelete",
      item,
      children: item.kind === "topic" ? item.setDocumentIds.length : 0,
    });

  return (
    <div>
      <TrashHeader
        action={
          <Button
            variant="danger-text"
            disabled={totalCount === 0 || dialogBusy}
            onClick={() => setPendingDialog({ kind: "empty" })}
          >
            {totalCount === 0 ? "空にする" : `空にする（${totalCount}）`}
          </Button>
        }
      />
      <div>
        {listFailure === null ? null : (
          <InlineAlert
            tone="error"
            retry={{
              label: listFailure.retryLabel,
              onRetry: listFailure.retry,
            }}
          >
            {listFailure.message}
          </InlineAlert>
        )}
        {base.length === 0 ? (
          <EmptyState message="ゴミ箱は空です" />
        ) : (
          <RowList aria-label="ゴミ箱の項目">
            {rows.map(({ item, children }) => {
              const groupBusy = busy.get(keyOf(item)) ?? null;
              return (
                <li key={keyOf(item)}>
                  <TrashRow
                    item={item}
                    level="item"
                    now={now}
                    busyLabel={groupBusy}
                    disabled={groupBusy !== null}
                    failure={rowFailure(item)}
                    onRestore={() => restore(item)}
                    onDelete={() => askHardDelete(item)}
                  />
                  {children.length > 0 && (
                    <ul aria-label="セットで削除されたドキュメント">
                      {children.map((child) => {
                        const childBusy = busy.get(keyOf(child)) ?? null;
                        return (
                          <li key={keyOf(child)}>
                            <TrashRow
                              item={child}
                              level="nested"
                              now={now}
                              busyLabel={childBusy}
                              disabled={
                                childBusy !== null || groupBusy !== null
                              }
                              failure={rowFailure(child)}
                              onRestore={() => restore(child)}
                              onDelete={() => askHardDelete(child)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </RowList>
        )}
        {totalCount > loaded &&
          (moreError !== null ? (
            <div className="pt-lg">
              <InlineAlert
                tone="error"
                retry={{ label: "再試行", onRetry: loadMore }}
              >
                {moreError}
              </InlineAlert>
            </div>
          ) : loadingMore ? (
            <LoadingRow label="読み込み中" />
          ) : (
            <div className="flex justify-center pt-lg">
              <Button variant="outline" onClick={loadMore}>
                もっと読む
              </Button>
            </div>
          ))}
      </div>

      <ConfirmDialog
        open={pendingDialog?.kind === "hardDelete"}
        title="完全に削除しますか？"
        description={
          pendingDialog?.kind === "hardDelete" && pendingDialog.children > 0
            ? `${HARD_DELETE_TEXT}このトピックのドキュメント（${pendingDialog.children}件）も一緒に削除されます。`
            : HARD_DELETE_TEXT
        }
        confirmLabel="完全に削除"
        danger
        onConfirm={confirmHardDelete}
        onCancel={() => setPendingDialog(null)}
      />
      <ConfirmDialog
        open={pendingDialog?.kind === "empty"}
        title="ゴミ箱を空にしますか？"
        description={`全件（${totalCount}件）が完全に削除され、元に戻せません。`}
        confirmLabel="空にする"
        pendingLabel="空にしています…"
        danger
        pending={dialogBusy}
        onConfirm={confirmEmpty}
        onCancel={() => setPendingDialog(null)}
      />
      <ConfirmDialog
        open={pendingDialog?.kind === "confirmSet"}
        title="トピックごと復元しますか？"
        description={
          pendingDialog?.kind === "confirmSet"
            ? `トピック「${pendingDialog.topicName}」もゴミ箱にあります。${
                pendingDialog.documentCount === null
                  ? "トピックとそのドキュメントも一緒に復元されます。"
                  : `トピックとそのドキュメント（${pendingDialog.documentCount}件）も一緒に復元されます。`
              }`
            : ""
        }
        confirmLabel="トピックごと復元"
        onConfirm={() => {
          if (
            pendingDialog?.kind !== "confirmSet" ||
            pendingDialog.item.kind !== "document"
          )
            return;
          const item = pendingDialog.item;
          setPendingDialog(null);
          restoreDocumentWith(item, { confirmSetRestore: true });
        }}
        onCancel={() => setPendingDialog(null)}
      />
      {pendingDialog?.kind === "destination" && (
        <RestoreDestinationDialog
          pending={dialogBusy}
          error={pendingDialog.error}
          onChoose={chooseDestination}
          onCancel={() => {
            if (!dialogBusy) setPendingDialog(null);
          }}
        />
      )}
    </div>
  );
}

function TrashRow({
  item,
  level,
  now,
  busyLabel,
  disabled,
  failure,
  onRestore,
  onDelete,
}: Readonly<{
  item: TrashItemView;
  level: RowLevel;
  now: Date;
  /** What is in flight on this row itself; `null` when nothing is. */
  busyLabel: string | null;
  /** Also true while the topic a nested row belongs to is being acted on. */
  disabled: boolean;
  failure: RowFailure | null;
  onRestore: () => void;
  onDelete: () => void;
}>) {
  const title = titleOf(item);
  return (
    <Row
      level={level}
      busy={busyLabel !== null}
      actions={
        <TrashRowActions
          title={title}
          disabled={disabled}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      }
      error={
        failure === null ? null : (
          <RowError
            message={failure.message}
            retry={{ label: failure.retryLabel, onRetry: failure.retry }}
          />
        )
      }
    >
      <p className="wrap-anywhere">{title}</p>
      {level === "item" ? (
        <TrashTags>
          <KindPill>{KIND_LABELS[item.kind]}</KindPill>
          {busyLabel === null ? (
            <RemainingDays>{remainingLabel(item.expiresAt, now)}</RemainingDays>
          ) : (
            <RowStatus label={busyLabel} />
          )}
        </TrashTags>
      ) : busyLabel === null ? null : (
        <p className="mt-xs">
          <RowStatus label={busyLabel} />
        </p>
      )}
    </Row>
  );
}
