"use client";

import type {
  TopicListView,
  TopicWithDocumentsView,
} from "@repo/core/application/knowledge/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  useActionState,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { blankFieldMessage, displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { createTopicFn, trashTopicFn } from "../actions";
import { isTopicResult, isTrashTopicResult } from "../schema";
import { type DisplayTopic, TopicRow } from "../TopicRow";

type ComposerState = Readonly<{ error: string | null }>;

type ListAction =
  | Readonly<{ kind: "add"; topic: DisplayTopic }>
  | Readonly<{ kind: "remove"; id: string }>;

/**
 * The list owner of P-06: creating (an optimistic row dispatched from the
 * form) and deleting (an optimistic removal behind a confirmation) are
 * membership changes, so both run here. Archived topics fold into
 * 「完了済み」, hidden when there is none.
 */
export function TopicList({ initial }: { initial: TopicListView }) {
  const router = useRouter();
  const create = useServerFn(createTopicFn);
  const trash = useServerFn(trashTopicFn);
  const nameId = useId();
  const nameErrorId = useId();
  const descriptionId = useId();
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [description, setDescription] = useState("");
  const [describing, setDescribing] = useState(false);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DisplayTopic | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<{
    topic: DisplayTopic;
    message: string;
  } | null>(null);
  const [deleting, startDelete] = useTransition();

  const base: DisplayTopic[] = initial.topics.filter(
    (topic) => !removed.has(topic.id),
  );
  const [optimistic, dispatch] = useOptimistic<DisplayTopic[], ListAction>(
    base,
    (current, action) =>
      action.kind === "add"
        ? [action.topic, ...current]
        : current.filter((topic) => topic.id !== action.id),
  );

  // One create per submit event (the same guard as the memo composer). A
  // blank name stops here too, before React queues the action, so the
  // message is the only thing the submit produces and the description stays.
  const inFlight = useRef(false);
  const guardSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (inFlight.current) {
      event.preventDefault();
      return;
    }
    if (name.trim().length === 0) {
      event.preventDefault();
      setNameMissing(true);
    }
  };

  const [state, action, pending] = useActionState<ComposerState, FormData>(
    async (previous, formData) => {
      const draftName = String(formData.get("name") ?? "").trim();
      if (draftName.length === 0) return previous;
      const draftDescription = String(formData.get("description") ?? "").trim();
      inFlight.current = true;
      const now = new Date();
      dispatch({
        kind: "add",
        topic: {
          id: `pending-${now.getTime()}`,
          name: draftName,
          description: draftDescription.length > 0 ? draftDescription : null,
          status: "active",
          version: 0,
          createdAt: now,
          updatedAt: now,
          documents: [],
          pending: true,
        },
      });
      try {
        readServerFnResult(
          await create({
            data: {
              name: draftName,
              description:
                draftDescription.length > 0 ? draftDescription : null,
            },
          }),
          isTopicResult,
          "createTopicFn",
        );
        setName("");
        setDescription("");
        setDescribing(false);
        await router.invalidate();
        return { error: null };
      } catch (failure) {
        return { error: displayError(failure) };
      } finally {
        inFlight.current = false;
      }
    },
    { error: null },
  );

  const runDelete = (topic: DisplayTopic) => {
    setDeleteFailure(null);
    startDelete(async () => {
      dispatch({ kind: "remove", id: topic.id });
      try {
        readServerFnResult(
          await trash({ data: { topicId: topic.id } }),
          isTrashTopicResult,
          "trashTopicFn",
        );
        setRemoved((current) => new Set(current).add(topic.id));
        setDeleteTarget(null);
        await router.invalidate();
      } catch (failure) {
        setDeleteTarget(null);
        setDeleteFailure({ topic, message: displayError(failure) });
      }
    });
  };

  const active = optimistic.filter((topic) => topic.status === "active");
  const archived = optimistic.filter((topic) => topic.status === "archived");
  const rows = (topics: readonly TopicWithDocumentsView[]) =>
    topics.map((topic) => (
      <TopicRow key={topic.id} topic={topic} onDelete={setDeleteTarget} />
    ));

  return (
    <section
      className="fog-topics"
      aria-label="トピック一覧"
      aria-busy={pending || deleting}
    >
      <form
        className="fog-create-row"
        action={action}
        onSubmit={guardSubmit}
        aria-label="新しいトピック"
      >
        <div className="fog-create-line">
          <label className="fog-sr-only" htmlFor={nameId}>
            新しいトピックの名前
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            className="fog-create-input"
            placeholder="新しいトピック"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameMissing(false);
            }}
            disabled={pending}
            maxLength={100}
            aria-invalid={nameMissing || undefined}
            aria-describedby={nameMissing ? nameErrorId : undefined}
          />
          <button type="submit" className="fog-primary" disabled={pending}>
            {pending ? "追加中…" : "追加"}
          </button>
        </div>
        {describing ? (
          <>
            <label className="fog-sr-only" htmlFor={descriptionId}>
              説明
            </label>
            <textarea
              id={descriptionId}
              name="description"
              className="fog-create-description"
              placeholder="説明（任意）"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={pending}
              rows={2}
              maxLength={500}
            />
          </>
        ) : (
          <button
            type="button"
            className="fog-text-button"
            onClick={() => setDescribing(true)}
          >
            説明を追加
          </button>
        )}
        {nameMissing && (
          <p className="fog-error" id={nameErrorId} role="alert">
            {blankFieldMessage("topicName")}
          </p>
        )}
        {state.error && (
          <p className="fog-error" role="alert">
            {state.error}
          </p>
        )}
      </form>
      {deleteFailure && (
        <p className="fog-error" role="alert">
          {deleteFailure.message}
          <button
            type="button"
            className="fog-text-button"
            onClick={() => runDelete(deleteFailure.topic)}
          >
            再試行
          </button>
        </p>
      )}
      {optimistic.length === 0 ? (
        <div className="fog-empty">
          <h2>最初のトピックを作ろう</h2>
          <p>ドキュメントを束ねる文脈です。上の入力欄から作れます。</p>
        </div>
      ) : (
        <>
          <div className="fog-topic-rows">{rows(active)}</div>
          {archived.length > 0 && (
            <>
              <button
                type="button"
                className="fog-section-toggle"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
              >
                <span
                  className={`fog-toggle-chevron${archivedOpen ? " open" : ""}`}
                  aria-hidden="true"
                >
                  ›
                </span>
                完了済み（{archived.length}）
              </button>
              {archivedOpen && (
                <section
                  className="fog-topic-rows"
                  aria-label="完了済みのトピック"
                >
                  {rows(archived)}
                </section>
              )}
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="トピックを削除しますか？"
        description="トピックと配下のドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={() => {
          if (deleteTarget) runDelete(deleteTarget);
        }}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />
    </section>
  );
}
