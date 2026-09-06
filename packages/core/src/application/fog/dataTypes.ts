import type { Actor, HumanActor, TopicView } from "./types";

export type ContentKind = "memo" | "document" | "topic";
export type ContentRef = Readonly<{ kind: ContentKind; id: string }>;
export type TrashParent =
  | Readonly<{ kind: "active" | "deleted"; id: string; title: string }>
  | Readonly<{ kind: "missing" }>;
export type TrashRecord = Readonly<{
  id: string;
  title: string;
  body: string;
  deletedAt: string;
  deletionGroupId: string | null;
  setDocumentIds: string[];
}> &
  (
    | Readonly<{ kind: "document"; topic: TrashParent }>
    | Readonly<{ kind: "memo" | "topic"; topic: null }>
  );
export type TrashItem = TrashRecord & Readonly<{ remainingDays: number }>;
export type RestoreInput = ContentRef &
  Readonly<{
    restoreTopicSet?: boolean;
    targetTopic?:
      | Readonly<{ kind: "existing"; id: string }>
      | Readonly<{ kind: "new"; title: string; description: string }>;
  }>;
export type SearchInput = Readonly<{
  query: string;
  topicId?: string;
  cursor?: string;
  limit?: number;
}>;
export type SearchResult = Readonly<{
  kind: "memo" | "document";
  id: string;
  title: string | null;
  snippet: string;
  createdAt: string;
  updatedAt: string;
  topicId: string | null;
  topicTitle: string | null;
  sourceIds: string[];
}>;
export type SearchPage = Readonly<{
  items: SearchResult[];
  nextCursor: string | null;
}>;
export type DataExport = Readonly<{
  format: "fog-export";
  version: 1;
  exportedAt: string;
  memos: Readonly<{
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }>[];
  topics: Omit<TopicView, "version">[];
  documents: Readonly<{
    id: string;
    topicId: string;
    title: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    sourceMemoIds: string[];
  }>[];
}>;
export interface DataServices {
  softDelete(
    actor: Actor,
    input: ContentRef & { expectedVersion: number },
  ): Promise<void>;
  trash(
    actor: HumanActor,
  ): Promise<{ items: TrashItem[]; retentionDays: number }>;
  restore(actor: HumanActor, input: RestoreInput): Promise<void>;
  hardDelete(actor: HumanActor, input: ContentRef): Promise<void>;
  emptyTrash(actor: HumanActor): Promise<void>;
  getSettings(actor: HumanActor): Promise<{ retentionDays: number }>;
  setRetentionDays(
    actor: HumanActor,
    input: { retentionDays: number },
  ): Promise<{ retentionDays: number }>;
  search(actor: Actor, input: SearchInput): Promise<SearchPage>;
  exportData(actor: HumanActor): Promise<DataExport>;
}
