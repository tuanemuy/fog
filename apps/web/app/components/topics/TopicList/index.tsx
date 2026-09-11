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
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { RowError } from "@/components/ui/RowError";
import { RowList } from "@/components/ui/RowList";
import { TextAreaField } from "@/components/ui/TextAreaField";
import { TextField } from "@/components/ui/TextField";
import { blankFieldMessage, displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { AddRowButton } from "../AddRow";
import { createTopicFn, trashTopicFn } from "../actions";
import { isTopicResult, isTrashTopicResult } from "../schema";
import { type DisplayTopic, TopicRow } from "../TopicRow";

type ComposerState = Readonly<{ error: string | null }>;

type ListAction =
  | Readonly<{ kind: "add"; topic: DisplayTopic }>
  | Readonly<{ kind: "remove"; id: string }>;

type DeleteFailure = Readonly<{ topic: DisplayTopic; message: string }>;

// `spec/design/pages/topics.html`, `.section-toggle`: a section label that
// opens and closes what follows. The hairline and the section gap above it
// are the section's, as with `KnowledgeSection`.
const SECTION_TOGGLE_CLASS =
  "mt-section flex w-full cursor-pointer items-center gap-sm border-t border-neutral-100 pt-lg pb-md text-left font-base text-xs font-semibold leading-tight tracking-label text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/**
 * The list owner of P-06 (`spec/design/pages/topics.html`): creating (an
 * optimistic row dispatched from the form) and deleting (an optimistic
 * removal behind a confirmation) are membership changes, so both run here.
 * The list ends in 「新しいトピック」, which turns into the create form in
 * its place. Archived topics fold into 「完了済み」, drawn only when there is
 * one. A failed delete puts its row back with the failure under it.
 */
export function TopicList({ initial }: { initial: TopicListView }) {
  const router = useRouter();
  const create = useServerFn(createTopicFn);
  const trash = useServerFn(trashTopicFn);
  const archivedListId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [description, setDescription] = useState("");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DisplayTopic | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<DeleteFailure | null>(
    null,
  );
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

  // Opening the form puts focus in its name field and closing it puts focus
  // back on 「新しいトピック」: each replaces the other, so the element that
  // had focus is gone.
  const nameRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (creating ? nameRef.current : addRef.current)?.focus();
  }, [creating]);
  const openForm = () => {
    moveFocus.current = true;
    setCreating(true);
  };
  const closeForm = () => {
    moveFocus.current = true;
    setCreating(false);
    setName("");
    setDescription("");
    setNameMissing(false);
  };

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
        closeForm();
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
  // The action's state outlives the form: a rejection dismissed with
  // キャンセル must not greet the next opening of it.
  const [dismissed, setDismissed] = useState<ComposerState | null>(null);
  const formError = state === dismissed ? null : state.error;
  const cancelForm = () => {
    setDismissed(state);
    closeForm();
  };

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
      <li key={topic.id}>
        <TopicRow
          topic={topic}
          onDelete={setDeleteTarget}
          error={
            deleteFailure?.topic.id === topic.id ? (
              <RowError
                message={deleteFailure.message}
                retry={{
                  label: "リトライ",
                  onRetry: () => runDelete(deleteFailure.topic),
                }}
              />
            ) : undefined
          }
        />
      </li>
    ));

  return (
    <section aria-label="トピック一覧" aria-busy={pending || deleting}>
      {optimistic.length === 0 ? (
        <EmptyState message="最初のトピックを作ってみましょう" />
      ) : null}
      <RowList aria-label="進行中のトピック">
        {rows(active)}
        <li>
          {creating ? (
            <form
              className="flex flex-col gap-sm py-row"
              action={action}
              onSubmit={guardSubmit}
              aria-label="新しいトピック"
            >
              {formError ? <FormError>{formError}</FormError> : null}
              <TextField
                ref={nameRef}
                label="トピック名"
                hideLabel
                name="name"
                placeholder="トピック名"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameMissing(false);
                }}
                disabled={pending}
                maxLength={100}
                error={nameMissing ? blankFieldMessage("topicName") : null}
              />
              <TextAreaField
                label="説明（任意）"
                hideLabel
                name="description"
                placeholder="説明（任意）"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={pending}
                rows={2}
                maxLength={500}
              />
              <div className="flex items-center justify-end gap-sm">
                <Button variant="text" disabled={pending} onClick={cancelForm}>
                  キャンセル
                </Button>
                <Button
                  variant="fill-sm"
                  type="submit"
                  disabled={pending || nameMissing}
                >
                  {pending ? "追加中…" : "追加"}
                </Button>
              </div>
            </form>
          ) : (
            <AddRowButton ref={addRef} onClick={openForm}>
              新しいトピック
            </AddRowButton>
          )}
        </li>
      </RowList>
      {archived.length > 0 ? (
        <>
          <button
            type="button"
            className={SECTION_TOGGLE_CLASS}
            aria-expanded={archivedOpen}
            aria-controls={archivedOpen ? archivedListId : undefined}
            onClick={() => setArchivedOpen((open) => !open)}
          >
            <span
              className={`flex shrink-0 transition-transform ${archivedOpen ? "rotate-90" : ""}`}
            >
              <Icon name="chevron-right" size="xs" />
            </span>
            完了済み（{archived.length}）
          </button>
          {archivedOpen ? (
            <div id={archivedListId}>
              <RowList aria-label="完了済みのトピック">
                {rows(archived)}
              </RowList>
            </div>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="トピックを削除しますか？"
        description="トピックとそのドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。"
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
