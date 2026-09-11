"use client";

import type { TopicView } from "@repo/core/application/knowledge/view";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { blankFieldMessage, displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { trashTopicFn, updateTopicFn } from "../actions";
import { isTopicResult, isTrashTopicResult } from "../schema";

type Patch = Readonly<{
  name?: string;
  description?: string | null;
  status?: TopicView["status"];
}>;

/**
 * The head of P-07: name and description with an inline editor, 完了にする /
 * 完了を解除 as one action, and the menu whose 削除 sits apart from them.
 * Renaming and archiving are in-item changes, so the island owns them with
 * an item-local `useOptimistic`; deleting leaves the screen, so it
 * navigates to the list once the server confirms.
 */
export function TopicHeader({ topic }: { topic: TopicView }) {
  const router = useRouter();
  const navigate = useNavigate();
  const update = useServerFn(updateTopicFn);
  const trash = useServerFn(trashTopicFn);
  const nameId = useId();
  const nameErrorId = useId();
  const descriptionId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(topic.name);
  const [nameMissing, setNameMissing] = useState(false);
  const [description, setDescription] = useState(topic.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [shown, patch] = useOptimistic<TopicView, Patch>(
    topic,
    (current, next) => ({ ...current, ...next }),
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

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
        setError(null);
        setEditing(false);
        await router.invalidate();
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };

  const toggleArchived = () => {
    setMenuOpen(false);
    const archived = shown.status !== "archived";
    startSave(async () => {
      patch({ status: archived ? "archived" : "active" });
      try {
        readServerFnResult(
          await update({ data: { topicId: topic.id, archived } }),
          isTopicResult,
          "updateTopicFn",
        );
        setError(null);
        await router.invalidate();
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };

  const confirmDelete = () => {
    startDelete(async () => {
      try {
        readServerFnResult(
          await trash({ data: { topicId: topic.id } }),
          isTrashTopicResult,
          "trashTopicFn",
        );
        await navigate({ to: "/topics" });
      } catch (failure) {
        setConfirming(false);
        setError(displayError(failure));
      }
    });
  };

  const archived = shown.status === "archived";
  return (
    <header className="fog-topic-head" aria-busy={saving || undefined}>
      {editing ? (
        <form
          className="fog-topic-edit"
          onSubmit={save}
          aria-label="トピックを編集"
        >
          <label className="fog-form-label" htmlFor={nameId}>
            名前
          </label>
          <input
            id={nameId}
            className="fog-field"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameMissing(false);
            }}
            disabled={saving}
            maxLength={100}
            aria-invalid={nameMissing || undefined}
            aria-describedby={nameMissing ? nameErrorId : undefined}
          />
          {nameMissing && (
            <p className="fog-error" id={nameErrorId} role="alert">
              {blankFieldMessage("topicName")}
            </p>
          )}
          <label className="fog-form-label" htmlFor={descriptionId}>
            説明
          </label>
          <textarea
            id={descriptionId}
            className="fog-field"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={saving}
            rows={3}
            maxLength={500}
            placeholder="説明（任意）"
          />
          <div className="fog-actions">
            <button type="submit" className="fog-primary" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="fog-secondary"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setNameMissing(false);
                setName(topic.name);
                setDescription(topic.description ?? "");
              }}
            >
              取り消し
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="fog-topic-title-row">
            <h2 className="fog-topic-title">
              {shown.name}
              {archived && <span className="fog-badge">完了</span>}
            </h2>
            <div className="fog-entry-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="fog-entry-menu"
                aria-label="トピックの操作"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                </svg>
              </button>
              {menuOpen && (
                <div className="fog-entry-pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="fog-pop-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setName(topic.name);
                      setDescription(topic.description ?? "");
                      setEditing(true);
                    }}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="fog-pop-item"
                    onClick={toggleArchived}
                  >
                    {archived ? "完了を解除" : "完了にする"}
                  </button>
                  <hr className="fog-pop-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="fog-pop-item fog-pop-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirming(true);
                    }}
                  >
                    削除
                  </button>
                </div>
              )}
            </div>
          </div>
          {shown.description && (
            <p className="fog-topic-desc">{shown.description}</p>
          )}
        </>
      )}
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="トピックを削除しますか？"
        description="トピックと配下のドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setConfirming(false);
        }}
      />
    </header>
  );
}
