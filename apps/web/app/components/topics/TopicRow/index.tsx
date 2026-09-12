"use client";

import type { TopicWithDocumentsView } from "@repo/core/application/knowledge/view";
import { Link } from "@tanstack/react-router";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import {
  PopoverMenu,
  PopoverMenuItem,
  PopoverMenuLink,
} from "@/components/ui/PopoverMenu";
import { Row } from "@/components/ui/Row";
import {
  ARCHIVED_TOPIC_NAME_CLASS,
  TOPIC_DESC_CLASS,
  TOPIC_NAME_CLASS,
} from "../styles";

export type DisplayTopic = TopicWithDocumentsView & { pending?: boolean };

const LONG_PRESS_MS = 500;

const COUNT_CLASS = "text-xs font-medium text-neutral-400";

/**
 * One row of P-06 (`spec/design/pages/topics.html`, `.topic-row`): the topic
 * as a link to P-07 with its document count and description, and its own
 * menu (編集 / 削除) — so it is a `Row`, whose only hover surface is the
 * menu. The menu also opens from a right click and a long press on the row
 * (`spec/pages/index.md`); deleting is asked of the list owner, which hands
 * back the failure of that delete as `error`. An archived row is set
 * neutral and drops its description.
 */
export function TopicRow({
  topic,
  onDelete,
  error,
}: {
  topic: DisplayTopic;
  onDelete: (topic: DisplayTopic) => void;
  /** The failure of this row's last delete (`RowError`), under the row. */
  error?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archived = topic.status === "archived";
  const nameClass = archived ? ARCHIVED_TOPIC_NAME_CLASS : TOPIC_NAME_CLASS;
  const description =
    topic.description && !archived ? (
      <span className={TOPIC_DESC_CLASS}>{topic.description}</span>
    ) : null;

  const cancelPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startPress = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    cancelPress();
    pressTimer.current = setTimeout(() => setMenuOpen(true), LONG_PRESS_MS);
  };

  if (topic.pending) {
    return (
      <Row busy>
        <span className={nameClass}>
          {topic.name}
          <span role="status" className={COUNT_CLASS}>
            保存中…
          </span>
        </span>
        {description}
      </Row>
    );
  }

  return (
    <Row
      error={error}
      actions={
        <PopoverMenu
          label="トピックの操作"
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          <PopoverMenuLink
            icon="edit"
            to="/topics/$topicId"
            params={{ topicId: topic.id }}
          >
            編集
          </PopoverMenuLink>
          <PopoverMenuItem
            icon="delete"
            tone="danger"
            onSelect={() => onDelete(topic)}
          >
            削除
          </PopoverMenuItem>
        </PopoverMenu>
      }
    >
      <Link
        className="block rounded-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
        <span className={nameClass}>
          {topic.name}
          <span className={COUNT_CLASS}>
            <span className="sr-only">ドキュメント数: </span>
            {topic.documents.length}
          </span>
        </span>
        {description}
      </Link>
    </Row>
  );
}
