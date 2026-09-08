import type {
  ActiveDocument,
  DocumentRevision,
  LiveTopic,
} from "@repo/core/domain/knowledge/entity";
import type {
  ActiveDocumentSummary,
  DocumentRevisionSummary,
} from "@repo/core/domain/knowledge/ports/documentRepository";
import { type ActorView, toActorView } from "../identity/view";

export type { ActorView };

export type TopicView = Readonly<{
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export function toTopicView(topic: LiveTopic): TopicView {
  return {
    id: topic.id,
    name: topic.name,
    description: topic.description,
    status: topic.status,
    version: topic.version,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
  };
}

export type TopicDocumentRowView = Readonly<{
  id: string;
  title: string;
  updatedAt: Date;
}>;

export function toTopicDocumentRowView(
  summary: ActiveDocumentSummary,
): TopicDocumentRowView {
  return { id: summary.id, title: summary.title, updatedAt: summary.updatedAt };
}

export type TopicWithDocumentsView = TopicView &
  Readonly<{ documents: readonly TopicDocumentRowView[] }>;

export type TopicListView = Readonly<{
  topics: readonly TopicWithDocumentsView[];
}>;

/** A memo cited by a topic's documents (P-07) or by one document (P-08). */
export type RelatedMemoView = Readonly<{
  memoId: string;
  snippet: string;
  postedAt: Date;
  /** Soft-deleted: shown as 「削除済みのメモ」, not navigable. */
  deleted: boolean;
}>;

export type TopicDetailView = Readonly<{
  topic: TopicView;
  documents: readonly TopicDocumentRowView[];
  relatedMemos: readonly RelatedMemoView[];
}>;

export type TopicNameView = Readonly<{ topicId: string; name: string }>;

export type TrashTopicView = Readonly<{
  topicId: string;
  trashedDocumentIds: readonly string[];
}>;

export type DocumentView = Readonly<{
  id: string;
  topicId: string;
  title: string;
  body: string;
  latestRevision: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export function toDocumentView(document: ActiveDocument): DocumentView {
  return {
    id: document.id,
    topicId: document.topicId,
    title: document.title,
    body: document.body,
    latestRevision: document.latestRevision,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export type CreateDocumentView = DocumentView &
  Readonly<{ sourceMemoIds: readonly string[] }>;

export type DocumentRevisionMetaView = Readonly<{
  revisionNumber: number;
  actor: ActorView;
  changeReason: string;
  createdAt: Date;
}>;

export function toDocumentRevisionMetaView(
  summary: DocumentRevisionSummary,
): DocumentRevisionMetaView {
  return {
    revisionNumber: summary.revisionNumber,
    actor: toActorView(summary.actor),
    changeReason: summary.changeReason,
    createdAt: summary.createdAt,
  };
}

export type DocumentRevisionView = DocumentRevisionMetaView &
  Readonly<{ title: string; body: string }>;

export function toDocumentRevisionView(
  revision: DocumentRevision,
): DocumentRevisionView {
  return {
    ...toDocumentRevisionMetaView(revision),
    title: revision.title,
    body: revision.body,
  };
}

export type DocumentRevisionsView = Readonly<{
  documentId: string;
  latestRevision: number;
  /** Ascending; never empty for an existing document. */
  revisions: readonly DocumentRevisionMetaView[];
}>;

export type DocumentDiffView = Readonly<{
  base: DocumentRevisionView;
  target: DocumentRevisionView;
}>;

/** What the warning shows when somebody else edited first (`editDocument`). */
export type DocumentConflictView = Readonly<{
  currentTitle: string;
  currentBody: string;
  /** Passed back as `expectedVersion` by "save anyway". */
  currentVersion: number;
  latestRevision: DocumentRevisionMetaView;
}>;

export type EditDocumentView = Readonly<{
  result: "saved" | "unchanged" | "conflict";
  latestRevision: number;
  version: number;
  updatedAt: Date;
  conflict: DocumentConflictView | null;
}>;

export type RollbackDocumentView = Readonly<{
  changed: boolean;
  latestRevision: number;
  version: number;
  updatedAt: Date;
}>;

export type SourceMemoView = RelatedMemoView & Readonly<{ linkedAt: Date }>;

export type SourceMemosView = Readonly<{
  sourceMemos: readonly SourceMemoView[];
}>;

export type ReferencingDocumentView = Readonly<{
  documentId: string;
  title: string;
  topicId: string;
  /** Soft-deleted: shown as 「削除済みのドキュメント」, not navigable. */
  deleted: boolean;
  linkedAt: Date;
}>;

export type ReferencingDocumentsView = Readonly<{
  documents: readonly ReferencingDocumentView[];
}>;
