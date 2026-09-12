"use client";

import type {
  DocumentConflictView,
  DocumentView,
  SourceMemoView,
} from "@repo/core/application/knowledge/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useActionState, useId, useRef, useState } from "react";
import { HeaderActions } from "@/components/layout/ShellSlots";
import { actorLabel } from "@/components/timeline/MemoEntry";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";
import { IconButton } from "@/components/ui/IconButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { TextField } from "@/components/ui/TextField";
import { useToast } from "@/components/ui/Toast";
import {
  blankFieldMessage,
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { createDocumentFn, editDocumentFn } from "../actions";
import { SourceMemoLine } from "../SourceMemoLine";
import { type PickedMemo, SourceMemoPicker } from "../SourceMemoPicker";
import { isCreateDocumentResult, isEditDocumentResult } from "../schema";
import {
  BODY_INPUT_CLASS,
  DOC_CONTEXT_CLASS,
  DOC_CONTEXT_LINK_CLASS,
  DOC_SECTION_CLASS,
  SHEET_ALERTS_CLASS,
  TITLE_INPUT_CLASS,
} from "../styles";

export type DocumentEditorProps =
  | Readonly<{ mode: "create"; topicId: string; topicName: string }>
  | Readonly<{
      mode: "edit";
      document: DocumentView;
      topicName: string;
      sourceMemos: readonly SourceMemoView[];
    }>;

type EditorState = Readonly<{ error: string | null }>;

/**
 * P-09 in both modes (`spec/design/pages/document-edit.html`). The form owns
 * the save, and survives it; its submit button sits in the header
 * (`HeaderActions`), outside the form's DOM and tied to it by `form`. Title
 * and body run on as one seamless editor under the topic. Create posts no
 * change reason (the application writes 「作成」) and picks its sources here;
 * edit shows the existing sources read-only, takes an optional reason
 * (blank → 「手動編集」) and carries
 * the `version` it opened with as the OCC token, answering a conflict with
 * the warning at the head of the sheet and 「そのまま保存」. A saved document
 * is announced by a toast on the way back to it.
 */
export function DocumentEditor(props: DocumentEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const create = useServerFn(createDocumentFn);
  const edit = useServerFn(editDocumentFn);
  const formId = useId();
  const titleId = useId();
  const bodyId = useId();
  const titleErrorId = useId();
  const sourcesLabelId = useId();
  const form = useRef<HTMLFormElement>(null);
  const editing = props.mode === "edit" ? props.document : null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [titleMissing, setTitleMissing] = useState(false);
  const [body, setBody] = useState(editing?.body ?? "");
  const [changeReason, setChangeReason] = useState("");
  const [picked, setPicked] = useState<readonly PickedMemo[]>([]);
  // The OCC token the editor opened with; a refetch must not move it.
  const [expectedVersion] = useState(editing?.version ?? 0);
  const [conflict, setConflict] = useState<DocumentConflictView | null>(null);

  // Two submits in one frame both arrive before the pending state disables
  // the button; the second is stopped before React queues its action. A
  // blank title stops here too, so the message is all the submit produces
  // and the body stays as typed.
  const inFlight = useRef(false);
  const guardSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (inFlight.current) {
      event.preventDefault();
      return;
    }
    if (title.trim().length === 0) {
      event.preventDefault();
      setTitleMissing(true);
    }
  };

  const [state, action, pending] = useActionState<EditorState, FormData>(
    async (_previous, formData) => {
      const nextTitle = String(formData.get("title") ?? "");
      const nextBody = String(formData.get("body") ?? "");
      if (nextTitle.trim().length === 0) return { error: null };
      inFlight.current = true;
      try {
        if (props.mode === "create") {
          const created = readServerFnResult(
            await create({
              data: {
                topicId: props.topicId,
                title: nextTitle,
                body: nextBody,
                sourceMemoIds: picked.map((memo) => memo.memoId),
              },
            }),
            isCreateDocumentResult,
            "createDocumentFn",
          );
          toast("保存しました");
          // Before the navigation, not after: the destination's cached match
          // is invalidated too, so the screen that opens is the saved one
          // rather than the version the router already holds.
          await router.invalidate();
          await router.navigate({
            to: "/documents/$documentId",
            params: { documentId: created.id },
          });
          return { error: null };
        }
        const reason = String(formData.get("changeReason") ?? "").trim();
        const result = readServerFnResult(
          await edit({
            data: {
              documentId: props.document.id,
              title: nextTitle,
              body: nextBody,
              changeReason: reason.length > 0 ? reason : null,
              expectedVersion: conflict?.currentVersion ?? expectedVersion,
            },
          }),
          isEditDocumentResult,
          "editDocumentFn",
        );
        if (result.result === "conflict") {
          setConflict(result.conflict);
          return { error: null };
        }
        toast("保存しました");
        await router.invalidate();
        await router.navigate({
          to: "/documents/$documentId",
          params: { documentId: props.document.id },
        });
        return { error: null };
      } catch (failure) {
        if (isOptimisticLockFailure(failure)) await router.invalidate();
        return { error: displayError(failure) };
      } finally {
        inFlight.current = false;
      }
    },
    { error: null },
  );

  const topicId =
    props.mode === "create" ? props.topicId : props.document.topicId;

  return (
    <form
      ref={form}
      id={formId}
      action={action}
      onSubmit={guardSubmit}
      aria-label={
        props.mode === "create" ? "ドキュメントを作成" : "ドキュメントを編集"
      }
    >
      <HeaderActions>
        <Button
          variant="fill-sm"
          type="submit"
          form={formId}
          disabled={pending}
        >
          {pending ? "保存中…" : conflict ? "そのまま保存" : "保存"}
        </Button>
      </HeaderActions>
      {conflict === null && state.error === null ? null : (
        <div className={SHEET_ALERTS_CLASS}>
          {conflict === null ? null : (
            <InlineAlert tone="warning">
              <p>
                編集中に {actorLabel(conflict.latestRevision.actor)}{" "}
                がこのドキュメントを更新しました。そのまま保存すると、自分の内容が新しいリビジョンになります。
              </p>
            </InlineAlert>
          )}
          {state.error === null ? null : (
            <InlineAlert
              tone="error"
              retry={{
                label: "再試行",
                onRetry: () => form.current?.requestSubmit(),
              }}
            >
              {state.error}
            </InlineAlert>
          )}
        </div>
      )}
      <p className={DOC_CONTEXT_CLASS}>
        <Link
          to="/topics/$topicId"
          params={{ topicId }}
          className={DOC_CONTEXT_LINK_CLASS}
        >
          {props.topicName}
        </Link>
      </p>
      <label className="sr-only" htmlFor={titleId}>
        タイトル
      </label>
      <input
        id={titleId}
        name="title"
        className={TITLE_INPUT_CLASS}
        placeholder="タイトル"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setTitleMissing(false);
        }}
        disabled={pending}
        aria-invalid={titleMissing || undefined}
        aria-describedby={titleMissing ? titleErrorId : undefined}
      />
      {titleMissing && (
        <div className="mt-sm">
          <FieldError id={titleErrorId}>
            {blankFieldMessage("documentTitle")}
          </FieldError>
        </div>
      )}
      <label className="sr-only" htmlFor={bodyId}>
        本文
      </label>
      <textarea
        id={bodyId}
        name="body"
        className={BODY_INPUT_CLASS}
        placeholder="本文を書く…"
        rows={16}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        disabled={pending}
      />
      {props.mode === "edit" && (
        <div className={DOC_SECTION_CLASS}>
          <TextField
            label="変更理由"
            name="changeReason"
            placeholder="手動編集"
            value={changeReason}
            onChange={(event) => setChangeReason(event.target.value)}
            disabled={pending}
            maxLength={400}
          />
        </div>
      )}
      {props.mode === "edit" ? (
        props.sourceMemos.length === 0 ? null : (
          <section
            aria-labelledby={sourcesLabelId}
            className={DOC_SECTION_CLASS}
          >
            <SectionLabel id={sourcesLabelId}>出典</SectionLabel>
            <RowList aria-labelledby={sourcesLabelId}>
              {props.sourceMemos.map((memo) => (
                <li key={memo.memoId}>
                  <Row>
                    <SourceMemoLine
                      postedAt={memo.postedAt}
                      snippet={memo.snippet}
                      deleted={memo.deleted}
                    />
                  </Row>
                </li>
              ))}
            </RowList>
          </section>
        )
      ) : (
        <section aria-labelledby={sourcesLabelId} className={DOC_SECTION_CLASS}>
          <SectionLabel id={sourcesLabelId}>出典</SectionLabel>
          {picked.length === 0 ? null : (
            <RowList aria-labelledby={sourcesLabelId}>
              {picked.map((memo) => (
                <li key={memo.memoId}>
                  <Row
                    actions={
                      <IconButton
                        icon="close"
                        label="出典から外す"
                        size="sm"
                        placement="row"
                        onClick={() =>
                          setPicked((current) =>
                            current.filter((m) => m.memoId !== memo.memoId),
                          )
                        }
                      />
                    }
                  >
                    <SourceMemoLine
                      postedAt={memo.postedAt}
                      snippet={memo.snippet}
                    />
                  </Row>
                </li>
              ))}
            </RowList>
          )}
          <SourceMemoPicker
            picked={picked}
            onPick={(memo) =>
              setPicked((current) =>
                current.some((m) => m.memoId === memo.memoId)
                  ? current
                  : [...current, memo],
              )
            }
          />
        </section>
      )}
    </form>
  );
}
