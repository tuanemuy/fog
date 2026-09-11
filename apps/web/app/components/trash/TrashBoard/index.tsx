"use client";

import type {
  TrashItemView,
  TrashListView,
} from "@repo/core/application/trash/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
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

/** The tag line of a top-level row: the set size for a topic, the set relation for a document whose topic is on another page. */
function metaOf(item: TrashItemView, children: number, now: Date): string {
  const remaining = remainingLabel(item.expiresAt, now);
  if (item.kind === "topic" && children > 0) {
    return `ドキュメント${item.setDocumentIds.length}件・${remaining}`;
  }
  if (item.kind === "document" && item.deletedWithTopic) {
    return `トピックとセットで削除・${remaining}`;
  }
  return remaining;
}

type Row = Readonly<{
  item: TrashItemView;
  children: readonly TrashItemView[];
}>;

/**
 * Groups the flat page: a document trashed with a topic that is on the same
 * page sits under it; one whose topic is not loaded stays a row of its own
 * with the set relation in its meta (decision △-2).
 */
export function groupRows(items: readonly TrashItemView[]): Row[] {
  const topics = new Set(
    items.filter((i) => i.kind === "topic").map((i) => i.id),
  );
  const rows: Row[] = [];
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

type Notice = Readonly<{ text: string; memoId?: string }>;
type RowFailure = Readonly<{
  key: string;
  message: string;
  retry: () => void;
  retryLabel?: string;
}>;

// Failures that belong to the list rather than to one row: 空にする, and a
// row that vanished under this tab (its row is already gone).
const LIST_FAILURE = "list";
type Pending =
  | Readonly<{ kind: "confirmSet"; item: TrashItemView; topicName: string }>
  | Readonly<{
      kind: "destination";
      item: TrashItemView;
      error: RestoreDestinationError | null;
    }>
  | Readonly<{ kind: "hardDelete"; item: TrashItemView; children: number }>
  | Readonly<{ kind: "empty" }>;

const keyOf = (item: TrashItemView) => `${item.kind}:${item.id}`;

/**
 * P-12, the owner of the list: restore, hard delete and empty all change
 * membership, so the rows are removed here optimistically and put back on a
 * failure with the message and a retry. A row being acted on is busy and
 * its buttons disabled (P-12 状態「操作中」).
 */
export function TrashBoard({ initial }: { initial: TrashListView }) {
  const router = useRouter();
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
  const [busy, markBusy] = useOptimistic<ReadonlySet<string>, string>(
    new Set(),
    (current, key) => new Set([...current, key]),
  );
  const [, startAction] = useTransition();
  const [pendingDialog, setPendingDialog] = useState<Pending | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
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
    label: string,
    run: () => Promise<readonly string[]>,
  ) => {
    const key = keyOf(item);
    setFailure(null);
    setNotice(null);
    startAction(async () => {
      markBusy(key);
      try {
        const gone = await run();
        dropRows(gone);
        setTotalCount((n) => Math.max(0, n - gone.length));
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

  const restore = (item: TrashItemView) => {
    if (item.kind === "memo") {
      act(item, "復元", async () => {
        readServerFnResult(
          await restoreMemo({ data: { memoId: item.id } }),
          isRestoreMemoResult,
          "restoreMemoFn",
        );
        setNotice({ text: "メモを復元しました", memoId: item.id });
        return [keyOf(item)];
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
        setNotice({ text: `トピック「${item.name}」を配下ごと復元しました` });
        return setKeys(item, null);
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
          setNotice({ text: `「${item.title}」を復元しました` });
          return setKeys(item, result.restoredTopicId);
        case "setRestoreConfirmationRequired":
          setPendingDialog({
            kind: "confirmSet",
            item,
            topicName: result.topicName,
          });
          return [];
        case "destinationSelectionRequired":
          setPendingDialog({ kind: "destination", item, error: null });
          return [];
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
          setNotice({ text: `「${item.title}」を復元しました` });
          await settle();
        } else if (result.result === "setRestoreConfirmationRequired") {
          setPendingDialog({
            kind: "confirmSet",
            item,
            topicName: result.topicName,
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
      setNotice({ text: `「${titleOf(item)}」を完全に削除しました` });
      return setKeys(item, null);
    });
  };

  const confirmEmpty = () => {
    setPendingDialog(null);
    setFailure(null);
    setNotice(null);
    setDialogBusy(true);
    startAction(async () => {
      try {
        const result = readServerFnResult(
          await empty({}),
          isEmptyTrashResult,
          "emptyTrashFn",
        );
        setDialogBusy(false);
        if (result.failedCount > 0) {
          setFailure({
            key: LIST_FAILURE,
            message: `${result.failedCount}件は削除できませんでした。もう一度お試しください`,
            retry: confirmEmpty,
          });
        } else {
          setNotice({
            text: `ゴミ箱を空にしました（${result.deletedCount}件）`,
          });
        }
        setTotalCount((n) => Math.max(0, n - result.deletedCount));
        await settle();
      } catch (error) {
        setDialogBusy(false);
        setFailure({
          key: LIST_FAILURE,
          message: `空にできませんでした: ${displayError(error)}`,
          retry: confirmEmpty,
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
        setMoreError(displayError(error));
      }
    });
  };

  const rows = groupRows(base);
  const loaded = initial.items.length + extra.length;

  return (
    <div className="fog-trash">
      <div className="fog-trash-header">
        <p className="fog-trash-note">
          ここにある項目は保持期限を過ぎると完全に削除されます。
        </p>
        <button
          type="button"
          className="fog-secondary fog-danger"
          disabled={totalCount === 0 || dialogBusy}
          onClick={() => setPendingDialog({ kind: "empty" })}
        >
          空にする（{totalCount}）
        </button>
      </div>
      {notice !== null && (
        <p className="fog-notice" role="status">
          {notice.text}
          {notice.memoId !== undefined && (
            <Link
              to="/"
              search={{ memo: notice.memoId }}
              className="fog-text-button"
            >
              タイムラインで見る
            </Link>
          )}
        </p>
      )}
      {failure !== null && failure.key === LIST_FAILURE && (
        <p className="fog-error" role="alert">
          {failure.message}
          <button
            type="button"
            className="fog-text-button"
            onClick={failure.retry}
          >
            {failure.retryLabel ?? "再試行"}
          </button>
        </p>
      )}
      {base.length === 0 ? (
        <div className="fog-empty" role="status">
          <h2>ゴミ箱は空です</h2>
          <p>削除したメモ・ドキュメント・トピックはここに入ります。</p>
        </div>
      ) : (
        <ul className="fog-trash-groups" aria-label="ゴミ箱の項目">
          {rows.map(({ item, children }) => (
            <li key={keyOf(item)} className="fog-trash-group">
              <TrashRow
                item={item}
                meta={metaOf(item, children.length, now)}
                busy={busy.has(keyOf(item))}
                failure={failure?.key === keyOf(item) ? failure : null}
                onRestore={() => restore(item)}
                onDelete={() =>
                  setPendingDialog({
                    kind: "hardDelete",
                    item,
                    children:
                      item.kind === "topic" ? item.setDocumentIds.length : 0,
                  })
                }
              />
              {children.length > 0 && (
                <ul
                  className="fog-trash-children"
                  aria-label="セットで削除されたドキュメント"
                >
                  {children.map((child) => (
                    <li key={keyOf(child)}>
                      <TrashRow
                        item={child}
                        meta="トピックとセットで削除"
                        child
                        busy={busy.has(keyOf(child)) || busy.has(keyOf(item))}
                        failure={failure?.key === keyOf(child) ? failure : null}
                        onRestore={() => restore(child)}
                        onDelete={() =>
                          setPendingDialog({
                            kind: "hardDelete",
                            item: child,
                            children: 0,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {totalCount > loaded && (
        <div className="fog-search-more">
          {moreError !== null && (
            <p className="fog-error" role="alert">
              {moreError}
            </p>
          )}
          <button
            type="button"
            className="fog-secondary"
            onClick={loadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? "読み込み中…" : "もっと読む"}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDialog?.kind === "hardDelete"}
        title="完全に削除しますか？"
        description={
          pendingDialog?.kind === "hardDelete" && pendingDialog.children > 0
            ? `「${titleOf(pendingDialog.item)}」と、セットで削除されたドキュメント${pendingDialog.children}件が対象です。履歴ごと消え、元に戻せません。`
            : pendingDialog?.kind === "hardDelete"
              ? `「${titleOf(pendingDialog.item)}」は履歴ごと消え、元に戻せません。`
              : ""
        }
        confirmLabel="完全に削除"
        danger
        onConfirm={confirmHardDelete}
        onCancel={() => setPendingDialog(null)}
      />
      <ConfirmDialog
        open={pendingDialog?.kind === "empty"}
        title={`ゴミ箱の${totalCount}件をすべて完全に削除しますか？`}
        description="すべての項目が履歴ごと消え、元に戻せません。"
        confirmLabel="すべて削除"
        danger
        pending={dialogBusy}
        onConfirm={confirmEmpty}
        onCancel={() => setPendingDialog(null)}
      />
      <ConfirmDialog
        open={pendingDialog?.kind === "confirmSet"}
        title={
          pendingDialog?.kind === "confirmSet"
            ? `トピック「${pendingDialog.topicName}」とセットで復元しますか？`
            : ""
        }
        description="所属トピックもゴミ箱にあります。このトピックと、一緒に削除されたドキュメントがすべて復元されます。"
        confirmLabel="セットで復元"
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
          documentTitle={titleOf(pendingDialog.item)}
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
  meta,
  child = false,
  busy,
  failure,
  onRestore,
  onDelete,
}: Readonly<{
  item: TrashItemView;
  meta: string;
  child?: boolean;
  busy: boolean;
  failure: RowFailure | null;
  onRestore: () => void;
  onDelete: () => void;
}>) {
  return (
    <div
      className={`fog-trash-row${child ? " fog-trash-child" : ""}${busy ? " pending" : ""}`}
      aria-busy={busy}
    >
      <div className="fog-trash-main">
        <p className={child ? "fog-trash-child-title" : "fog-trash-title"}>
          {titleOf(item)}
        </p>
        <p className="fog-trash-tags">
          {!child && (
            <span className="fog-trash-pill">{KIND_LABELS[item.kind]}</span>
          )}
          <span className="fog-remaining">{meta}</span>
          <time dateTime={item.trashedAt.toISOString()} className="fog-meta">
            {formatDateTime(item.trashedAt)} に削除
          </time>
        </p>
        {failure !== null && (
          <p className="fog-error" role="alert">
            {failure.message}
            <button
              type="button"
              className="fog-text-button"
              onClick={failure.retry}
            >
              再試行
            </button>
          </p>
        )}
      </div>
      <div className="fog-row-actions">
        <button
          type="button"
          className="fog-secondary"
          onClick={onRestore}
          disabled={busy}
          aria-label={`${titleOf(item)} を復元`}
        >
          復元
        </button>
        <button
          type="button"
          className="fog-secondary fog-danger"
          onClick={onDelete}
          disabled={busy}
          aria-label={`${titleOf(item)} を完全に削除`}
        >
          完全に削除
        </button>
      </div>
    </div>
  );
}
