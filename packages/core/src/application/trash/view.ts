import type { TrashItem } from "@repo/core/domain/trash/valueObject";

export type TrashItemView =
  | Readonly<{
      kind: "memo";
      id: string;
      excerpt: string;
      trashedAt: Date;
      expiresAt: Date;
    }>
  | Readonly<{
      kind: "document";
      id: string;
      title: string;
      topicId: string;
      deletedWithTopic: boolean;
      trashedAt: Date;
      expiresAt: Date;
    }>
  | Readonly<{
      kind: "topic";
      id: string;
      name: string;
      setDocumentIds: readonly string[];
      trashedAt: Date;
      expiresAt: Date;
    }>;

export function toTrashItemView(item: TrashItem): TrashItemView {
  return item;
}

export type TrashListView = Readonly<{
  items: readonly TrashItemView[];
  totalCount: number;
  page: number;
  limit: number;
}>;

export type RestoreMemoView = Readonly<{ memoId: string }>;

export type RestoreDocumentView =
  | Readonly<{
      result: "restored";
      documentId: string;
      /** The topic restored or created alongside; `null` for a lone restore. */
      restoredTopicId: string | null;
    }>
  | Readonly<{
      result: "setRestoreConfirmationRequired";
      documentId: string;
      topicId: string;
      topicName: string;
    }>
  | Readonly<{ result: "destinationSelectionRequired"; documentId: string }>;

export type RestoreTopicView = Readonly<{
  topicId: string;
  restoredDocumentIds: readonly string[];
}>;

/** `failedCount` is what the screen needs for 「エラー + リトライ」. */
export type EmptyTrashView = Readonly<{
  deletedCount: number;
  failedCount: number;
}>;
