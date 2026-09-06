"use client";
import type { TopicView, TrashItem } from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  emptyFogTrash,
  hardDeleteFogContent,
  restoreFogContent,
} from "@/presentation/fogDataActions";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  isTrashEmpty,
  isTrashRestoreDisabled,
  partialTrashMessage,
  runTrashPurgeMutation,
  runWithInvalidation,
} from "./trashMutation";

type Intent =
  | { kind: "restore" | "destroy"; item: TrashItem }
  | { kind: "empty" };
const labels = { memo: "メモ", document: "ドキュメント", topic: "トピック" };
const key = (item: TrashItem) => `${item.kind}:${item.id}`;
const time = (date: string) =>
  new Date(date).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

export function TrashBoard({
  data,
  topics,
}: {
  data: {
    items: TrashItem[];
    retentionDays: number;
    purgingCount: number;
  };
  topics: TopicView[];
}) {
  const router = useRouter();
  const restore = useServerFn(restoreFogContent);
  const destroy = useServerFn(hardDeleteFogContent);
  const empty = useServerFn(emptyFogTrash);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [destination, setDestination] = useState(topics[0]?.id ?? "new");
  const [newTitle, setNewTitle] = useState("");
  const [shown, hide] = useOptimistic(data.items, (items, ids: string[]) =>
    items.filter((item) => !ids.includes(key(item))),
  );
  const choose = (next: Intent) => {
    setError(null);
    setNotice(null);
    setNewTitle("");
    setDestination(topics[0]?.id ?? "new");
    setIntent(next);
  };
  const missing =
    intent?.kind === "restore" &&
    intent.item.kind === "document" &&
    intent.item.topic.kind === "missing";
  const parentDeleted =
    intent?.kind === "restore" &&
    intent.item.kind === "document" &&
    intent.item.topic.kind === "deleted";
  const run = () =>
    start(async () => {
      if (!intent) return;
      const hidden =
        intent.kind === "empty"
          ? data.items.map(key)
          : [
              key(intent.item),
              ...(intent.item.kind === "topic" || parentDeleted
                ? intent.item.setDocumentIds.map((id) => `document:${id}`)
                : []),
              ...(parentDeleted && intent.item.topic?.kind === "deleted"
                ? [`topic:${intent.item.topic.id}`]
                : []),
            ];
      hide(hidden);
      try {
        if (intent.kind === "empty") {
          const result = await runTrashPurgeMutation(
            () => empty({ data: {} }),
            () => router.invalidate(),
          );
          if (result.status === "partial") {
            setNotice(partialTrashMessage(result));
            return;
          }
          setNotice("ゴミ箱を空にしました。");
          setIntent(null);
          return;
        }
        if (intent.kind === "destroy") {
          const result = await runTrashPurgeMutation(
            () =>
              destroy({
                data: { kind: intent.item.kind, id: intent.item.id },
              }),
            () => router.invalidate(),
          );
          if (result.status === "partial") {
            setNotice(partialTrashMessage(result));
            return;
          }
          setNotice("完全削除が完了しました。");
          setIntent(null);
          return;
        }
        await runWithInvalidation(
          () =>
            restore({
              data: {
                kind: intent.item.kind,
                id: intent.item.id,
                ...(parentDeleted ? { restoreTopicSet: true } : {}),
                ...(missing
                  ? {
                      targetTopic:
                        destination === "new"
                          ? {
                              kind: "new" as const,
                              title: newTitle,
                              description: "",
                            }
                          : { kind: "existing" as const, id: destination },
                    }
                  : {}),
              },
            }),
          () => router.invalidate(),
        );
        setIntent(null);
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  return (
    <section className="fog-content" aria-label="ゴミ箱" aria-busy={pending}>
      <div className="fog-section-heading">
        <h2>ゴミ箱</h2>
        <button
          type="button"
          className="fog-text-button"
          disabled={isTrashEmpty(shown.length, data.purgingCount) || pending}
          onClick={() => choose({ kind: "empty" })}
        >
          空にする
        </button>
      </div>
      <p className="fog-hint">
        削除から{data.retentionDays}
        日間は復元できます。期限を過ぎると履歴ごと完全に削除されます。
        <Link to="/settings">保持期限を変更</Link>
      </p>
      {data.purgingCount > 0 && (
        <p className="fog-hint" role="status">
          {data.purgingCount}件は履歴を含めて削除処理中です。
        </p>
      )}
      {notice && (
        <p className="fog-hint" role="status">
          {notice}
        </p>
      )}
      {isTrashEmpty(shown.length, data.purgingCount) ? (
        <div className="fog-empty">
          <h3>ゴミ箱は空です</h3>
          <p>削除した項目はここから復元できます。</p>
        </div>
      ) : (
        shown.map((item) => (
          <article className="fog-trash-row" key={key(item)}>
            <div className="fog-section-heading">
              <span className="fog-badge">{labels[item.kind]}</span>
              <span className="fog-meta">
                {item.purging
                  ? "完全削除処理中"
                  : item.remainingDays > 0
                    ? `残り${item.remainingDays}日`
                    : "次の自動削除で完全に削除"}
              </span>
            </div>
            <h3>{item.title}</h3>
            {item.kind === "memo" && (
              <p className="fog-source-text">{item.body}</p>
            )}
            <p className="fog-meta">削除 {time(item.deletedAt)}</p>
            {item.kind === "topic" && (
              <p className="fog-hint">
                セットのドキュメント {item.setDocumentIds.length}件
              </p>
            )}
            {item.kind === "document" && (
              <p className="fog-hint">
                {item.topic.kind === "purging"
                  ? "元のトピックは完全削除処理中のため復元できません。"
                  : item.topic.kind === "missing"
                    ? "元のトピックは完全に削除されています。復元先を選べます。"
                    : item.topic.kind === "deleted"
                      ? `「${item.topic.title}」もゴミ箱にあります。${item.setDocumentIds.includes(item.id) ? "トピックとセットで削除" : "トピックより前に個別削除"}`
                      : `復元先: ${item.topic.title}`}
              </p>
            )}
            <div className="fog-actions">
              <button
                type="button"
                className="fog-secondary"
                disabled={
                  pending ||
                  isTrashRestoreDisabled(
                    item.purging,
                    item.kind === "document" && item.topic.kind === "purging",
                  )
                }
                onClick={() => choose({ kind: "restore", item })}
              >
                復元
              </button>
              <button
                type="button"
                className="fog-text-button fog-danger"
                disabled={pending}
                onClick={() => choose({ kind: "destroy", item })}
              >
                完全に削除
              </button>
            </div>
          </article>
        ))
      )}
      {intent && (
        <ConfirmDialog
          title={
            intent.kind === "restore"
              ? "項目を復元しますか？"
              : intent.kind === "empty"
                ? "ゴミ箱を空にしますか？"
                : "完全に削除しますか？"
          }
          pending={pending}
          onCancel={() => setIntent(null)}
        >
          {intent.kind === "empty" ? (
            <p>
              {data.items.length}
              件すべてを、リビジョン履歴ごと完全に削除します。元に戻せません。
            </p>
          ) : (
            <>
              <p>{intent.item.title}</p>
              {intent.kind === "destroy" ? (
                <p>
                  リビジョン履歴ごと完全に消え、元に戻せません。
                  {intent.item.kind === "topic" &&
                    `セットのドキュメント${intent.item.setDocumentIds.length}件も履歴ごと消去します。`}
                </p>
              ) : (
                <p>
                  {parentDeleted
                    ? "所属トピックとセットのドキュメントも一緒に復元します。"
                    : intent.item.kind === "topic"
                      ? `セットで削除したドキュメント${intent.item.setDocumentIds.length}件も復元します。先に個別削除した文書はゴミ箱に残ります。`
                      : missing
                        ? "復元先のトピックを指定してください。"
                        : "元の場所へ戻します。"}
                </p>
              )}
            </>
          )}
          {missing && (
            <div className="fog-editor-form">
              <label htmlFor="restore-topic">復元先トピック</label>
              <select
                id="restore-topic"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                disabled={pending}
              >
                {topics.map((topic) => (
                  <option value={topic.id} key={topic.id}>
                    {topic.title}
                    {topic.completed ? "（完了済み）" : ""}
                  </option>
                ))}
                <option value="new">新しいトピックを作成</option>
              </select>
              {destination === "new" && (
                <>
                  <label htmlFor="restore-title">新しいトピックの名前</label>
                  <input
                    id="restore-title"
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    maxLength={200}
                    disabled={pending}
                  />
                </>
              )}
            </div>
          )}
          {error && (
            <p className="fog-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={`fog-primary${intent.kind === "restore" ? "" : " fog-danger-primary"}`}
            disabled={
              pending || (missing && destination === "new" && !newTitle.trim())
            }
            onClick={run}
          >
            {pending
              ? "処理中…"
              : intent.kind === "restore"
                ? parentDeleted
                  ? "確認してセットで復元"
                  : "復元する"
                : intent.kind === "empty"
                  ? notice
                    ? "残りを削除"
                    : "すべて完全に削除"
                  : notice
                    ? "削除を続ける"
                    : "完全に削除する"}
          </button>
        </ConfirmDialog>
      )}
    </section>
  );
}
