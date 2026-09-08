import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";

/**
 * One row of the trash: a read-only projection over memo / knowledge's
 * trashed rows (`spec/domains/trash.md`). `expiresAt` is the stored
 * `purgeAfter`, never a recomputation.
 */
export type TrashedMemoItem = Readonly<{
  kind: "memo";
  id: MemoId;
  excerpt: string;
  trashedAt: Date;
  expiresAt: Date;
}>;

export type TrashedDocumentItem = Readonly<{
  kind: "document";
  id: DocumentId;
  title: string;
  /** The topic at the time of deletion; decides the restore branch. */
  topicId: TopicId;
  deletedWithTopic: boolean;
  trashedAt: Date;
  expiresAt: Date;
}>;

export type TrashedTopicItem = Readonly<{
  kind: "topic";
  id: TopicId;
  name: string;
  /** Documents trashed together with the topic; the set restore / set delete targets. */
  setDocumentIds: readonly DocumentId[];
  trashedAt: Date;
  expiresAt: Date;
}>;

export type TrashItem =
  | TrashedMemoItem
  | TrashedDocumentItem
  | TrashedTopicItem;

export type TrashItemRef =
  | Readonly<{ kind: "memo"; id: MemoId }>
  | Readonly<{ kind: "document"; id: DocumentId }>
  | Readonly<{ kind: "topic"; id: TopicId }>;

export type TrashItemKind = TrashItem["kind"];
