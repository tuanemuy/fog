"use client";

import type { TopicWithDocumentsView } from "@repo/core/application/knowledge/view";
import { Link, useNavigate } from "@tanstack/react-router";
import { type PointerEvent, useEffect, useRef, useState } from "react";

export type DisplayTopic = TopicWithDocumentsView & { pending?: boolean };

const LONG_PRESS_MS = 500;

/**
 * One row of P-06: the topic (a link to P-07) with the document count and
 * the description, and its menu (編集 / 削除). The menu opens from the
 * button, from a right click and from a long press (`spec/pages/index.md`);
 * deleting is asked of the list owner.
 */
export function TopicRow({
  topic,
  onDelete,
}: {
  topic: DisplayTopic;
  onDelete: (topic: DisplayTopic) => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const cancelPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startPress = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    cancelPress();
    pressTimer.current = setTimeout(() => setMenuOpen(true), LONG_PRESS_MS);
  };

  return (
    <div
      className={`fog-topic-row${topic.status === "archived" ? " archived" : ""}${topic.pending ? " pending" : ""}`}
      aria-busy={topic.pending ? true : undefined}
    >
      {topic.pending ? (
        <span className="fog-topic-row-main">
          <span className="fog-topic-name">
            {topic.name}
            <span role="status" className="fog-topic-pending">
              保存中…
            </span>
          </span>
          {topic.description && (
            <span className="fog-topic-desc">{topic.description}</span>
          )}
        </span>
      ) : (
        <Link
          className="fog-topic-row-main"
          to="/topics/$topicId"
          params={{ topicId: topic.id }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
          }}
          onPointerDown={startPress}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
        >
          <span className="fog-topic-name">
            {topic.name}
            <span className="fog-topic-count">
              <span className="fog-sr-only">ドキュメント数: </span>
              {topic.documents.length}
            </span>
          </span>
          {topic.description && (
            <span className="fog-topic-desc">{topic.description}</span>
          )}
        </Link>
      )}
      {!topic.pending && (
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
                  void navigate({
                    to: "/topics/$topicId",
                    params: { topicId: topic.id },
                  });
                }}
              >
                編集
              </button>
              <button
                type="button"
                role="menuitem"
                className="fog-pop-item fog-pop-danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(topic);
                }}
              >
                削除
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
