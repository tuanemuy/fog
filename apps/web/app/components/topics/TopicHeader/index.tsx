"use client";

import type { TopicView } from "@repo/core/application/knowledge/view";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { PopoverMenu, PopoverMenuItem } from "@/components/ui/PopoverMenu";
import { TextAreaField } from "@/components/ui/TextAreaField";
import { TextField } from "@/components/ui/TextField";
import { blankFieldMessage, displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { trashTopicFn, updateTopicFn } from "../actions";
import { isTopicResult, isTrashTopicResult } from "../schema";
import {
  TOPIC_DETAIL_DESC_CLASS,
  TOPIC_HEAD_CLASS,
  TOPIC_STATUS_CLASS,
  TOPIC_TITLE_CLASS,
} from "../styles";

type Patch = Readonly<{
  name?: string;
  description?: string | null;
  status?: TopicView["status"];
}>;

/**
 * The head of P-07 (`spec/design/pages/topic-detail.html`, `.topic-head` /
 * `.topic-status`): the name as the page's `h1` (the route declares
 * `h1: "sheet"`) with its menu (編集 / 削除), the description,
 * and under them 完了にする / 完了を解除 as a visible one-action button — the
 * complete action never shares a menu with 削除 (spec/pages P-07). 編集 turns
 * the head into its form in place.
 *
 * Renaming and archiving are in-item changes, so the island owns them with
 * an item-local `useOptimistic`; deleting leaves the screen, so it
 * navigates to the list once the server confirms. A rejected save stays in
 * its form (`FormError`); a rejected archive or delete is told under the
 * head (`InlineAlert`).
 */
export function TopicHeader({ topic }: { topic: TopicView }) {
  const router = useRouter();
  const navigate = useNavigate();
  const update = useServerFn(updateTopicFn);
  const trash = useServerFn(trashTopicFn);
  const nameRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(topic.name);
  const [nameMissing, setNameMissing] = useState(false);
  const [description, setDescription] = useState(topic.description ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [shown, patch] = useOptimistic<TopicView, Patch>(
    topic,
    (current, next) => ({ ...current, ...next }),
  );

  // 編集 is chosen from a menu that the form replaces, so focus would be
  // left on nothing; it goes to the name instead.
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  const startEditing = () => {
    setName(topic.name);
    setDescription(topic.description ?? "");
    setNameMissing(false);
    setFormError(null);
    setEditing(true);
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = name.trim();
    if (saving) return;
    if (nextName.length === 0) {
      setNameMissing(true);
      return;
    }
    const nextDescription = description.trim();
    startSave(async () => {
      patch({
        name: nextName,
        description: nextDescription.length > 0 ? nextDescription : null,
      });
      try {
        readServerFnResult(
          await update({
            data: {
              topicId: topic.id,
              name: nextName,
              description: nextDescription.length > 0 ? nextDescription : null,
            },
          }),
          isTopicResult,
          "updateTopicFn",
        );
        setFormError(null);
        setEditing(false);
        await router.invalidate();
      } catch (failure) {
        setFormError(displayError(failure));
      }
    });
  };

  const toggleArchived = () => {
    const archived = shown.status !== "archived";
    setError(null);
    startSave(async () => {
      patch({ status: archived ? "archived" : "active" });
      try {
        readServerFnResult(
          await update({ data: { topicId: topic.id, archived } }),
          isTopicResult,
          "updateTopicFn",
        );
        await router.invalidate();
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };

  const confirmDelete = () => {
    setError(null);
    startDelete(async () => {
      let trashed = false;
      try {
        readServerFnResult(
          await trash({ data: { topicId: topic.id } }),
          isTrashTopicResult,
          "trashTopicFn",
        );
        trashed = true;
        // Everything the router holds was read before this delete, the topic
        // list ahead included. Dropping the cache is what makes that list
        // load fresh, and it is the only reconciliation that leaves this
        // screen's own loader alone: `router.invalidate()` ends in `load()`,
        // which re-runs the loaders of the matches still mounted whenever
        // they are stale (`staleTime: 0` under `pnpm dev`) — this one would
        // answer `notFound()` and draw 「トピックが見つかりません」 over the
        // head before the navigation lands.
        router.clearCache();
        await navigate({ to: "/topics" });
        // The screen just left is in the cache now, holding the topic that
        // is no longer there.
        router.clearCache();
      } catch (failure) {
        // The delete is confirmed or refused by this point; either way the
        // dialog has had its answer, and leaving it open would let a second
        // confirm send an id that is already in the trash.
        setConfirming(false);
        // The server already confirmed the delete, so a failure past that
        // point is the navigation's: reporting it here would call a finished
        // delete failed.
        if (trashed) return;
        setError(displayError(failure));
      }
    });
  };

  const archived = shown.status === "archived";
  return (
    <div aria-busy={saving || undefined}>
      {editing ? (
        <form
          className="flex flex-col gap-sm"
          onSubmit={save}
          aria-label="トピックを編集"
        >
          {formError ? <FormError>{formError}</FormError> : null}
          <TextField
            ref={nameRef}
            label="トピック名"
            hideLabel
            placeholder="トピック名"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameMissing(false);
            }}
            disabled={saving}
            maxLength={100}
            error={nameMissing ? blankFieldMessage("topicName") : null}
          />
          <TextAreaField
            label="説明"
            hideLabel
            placeholder="説明（任意）"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={saving}
            rows={2}
            maxLength={500}
          />
          <div className="flex items-center justify-end gap-sm">
            <Button
              variant="text"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setNameMissing(false);
                setFormError(null);
              }}
            >
              キャンセル
            </Button>
            <Button
              variant="fill-sm"
              type="submit"
              disabled={saving || nameMissing}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className={TOPIC_HEAD_CLASS}>
            <h1 className={TOPIC_TITLE_CLASS}>{shown.name}</h1>
            <PopoverMenu label="トピックの操作">
              <PopoverMenuItem icon="edit" onSelect={startEditing}>
                編集
              </PopoverMenuItem>
              <PopoverMenuItem
                icon="delete"
                tone="danger"
                onSelect={() => setConfirming(true)}
              >
                削除
              </PopoverMenuItem>
            </PopoverMenu>
          </div>
          {shown.description ? (
            <p className={TOPIC_DETAIL_DESC_CLASS}>{shown.description}</p>
          ) : null}
          <div className={TOPIC_STATUS_CLASS}>
            {archived ? (
              <span className="font-base text-xs leading-tight text-neutral-400">
                完了済み
              </span>
            ) : null}
            <Button
              variant="outline"
              onClick={toggleArchived}
              disabled={saving}
            >
              <span className="flex text-neutral-500">
                <Icon name={archived ? "restore" : "check"} size="sm" />
              </span>
              {archived ? "完了を解除" : "完了にする"}
            </Button>
          </div>
        </>
      )}
      {error ? (
        <div className="mt-md">
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="トピックを削除しますか？"
        description="トピックとそのドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setConfirming(false);
        }}
      />
    </div>
  );
}
