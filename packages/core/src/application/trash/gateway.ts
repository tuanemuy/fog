import type {
  EmptyTrashView,
  RestoreDocumentView,
  RestoreMemoView,
  RestoreTopicView,
  TrashListView,
} from "./view";

export type ListTrashDto = Readonly<{ page: number; limit: number }>;

export type RestoreDestinationDto =
  | Readonly<{ kind: "existing"; topicId: string }>
  | Readonly<{ kind: "new"; name: string; description: string | null }>;

export type RestoreDocumentDto = Readonly<{
  documentId: string;
  confirmSetRestore: boolean;
  destination: RestoreDestinationDto | null;
}>;

export type TrashItemRefDto = Readonly<{
  kind: "memo" | "document" | "topic";
  id: string;
}>;

/** Human-UI only: never wired to the AI presentation (`spec/domains/trash.md` AI非公開). */
export interface TrashGateway {
  listTrash(userId: string, input: ListTrashDto): Promise<TrashListView>;
  restoreMemo(userId: string, memoId: string): Promise<RestoreMemoView>;
  restoreDocument(
    userId: string,
    input: RestoreDocumentDto,
  ): Promise<RestoreDocumentView>;
  restoreTopic(userId: string, topicId: string): Promise<RestoreTopicView>;
  hardDeleteTrashItem(userId: string, ref: TrashItemRefDto): Promise<void>;
  emptyTrash(userId: string): Promise<EmptyTrashView>;
}
