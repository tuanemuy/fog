import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import type {
  ActiveDocument,
  Document,
  DocumentRevision,
  SourceLink,
  TrashedDocument,
} from "../entity";
import type { DocumentId, RevisionNumber, TopicId } from "../valueObject";

/**
 * What a listing draws of a document (a read projection): no body, no OCC
 * token, so it cannot reach a `save`.
 */
type DocumentSummaryFields =
  | "id"
  | "topicId"
  | "title"
  | "updatedAt"
  | "status";
export type ActiveDocumentSummary = Pick<ActiveDocument, DocumentSummaryFields>;
export type DocumentSummary = Pick<Document, DocumentSummaryFields>;

/**
 * What the history list draws of a revision (a read projection, decision
 * △-10 / spec `121ffe7`): who, when, why — never the body. `documentId` is
 * the argument, so it is not repeated.
 */
export type DocumentRevisionSummary = Pick<
  DocumentRevision,
  "revisionNumber" | "actor" | "changeReason" | "createdAt"
>;

/**
 * The document aggregate: the row, its revisions and its source links.
 * Same OCC contract as `TransactionalRepository` without extending it.
 * Every write also maintains the search projection inside the same
 * transaction (`spec/domains/search.md`). `userId` is never an argument.
 */
export interface DocumentRepository {
  insert(document: ActiveDocument): void;
  save(document: Document, expectedVersion: ExpectedVersion<Document>): void;
  /** Hard delete: the row, every revision and every link on the document side. */
  delete(id: DocumentId, expectedVersion: ExpectedVersion<Document>): void;

  /** Active only; trashed is `null`. */
  findById(id: DocumentId): Versioned<ActiveDocument> | null;
  /** Any state. Human UI and trash usecases only. */
  findByIdIncludingTrashed(id: DocumentId): Versioned<Document> | null;

  /** Trashed included, absent (hard-deleted) ids dropped; no promised order. */
  listSummariesByIdsIncludingTrashed(
    ids: readonly DocumentId[],
  ): readonly DocumentSummary[];

  /** Active documents of a topic with OCC tokens (set deletion). */
  listActiveByTopic(topicId: TopicId): readonly Versioned<ActiveDocument>[];
  /** Active documents of a topic, `updatedAt` descending then `id` ascending. */
  listActiveSummariesByTopic(
    topicId: TopicId,
  ): readonly ActiveDocumentSummary[];
  /** Active documents of several topics in one query; the caller groups by `topicId`. */
  listActiveSummariesByTopics(
    topicIds: readonly TopicId[],
  ): readonly ActiveDocumentSummary[];
  /** Trashed documents of a topic with OCC tokens (set restore, topic hard delete). */
  listTrashedByTopic(topicId: TopicId): readonly Versioned<TrashedDocument>[];
  /** Trash listing material for the `TrashQueryPort` adapter; not for usecases. */
  listTrashedByUser(): readonly Versioned<TrashedDocument>[];

  /** Append-only; a `(documentId, revisionNumber)` duplicate is an OCC conflict. */
  insertRevision(revision: DocumentRevision): void;
  /** Ascending by `revisionNumber`; at least one row for an existing document. */
  listRevisionSummaries(
    documentId: DocumentId,
  ): readonly DocumentRevisionSummary[];
  findRevision(
    documentId: DocumentId,
    revisionNumber: RevisionNumber,
  ): DocumentRevision | null;

  /** With `Document.create`, in the same unit of work. */
  insertSourceLinks(links: readonly SourceLink[]): void;
  listSourceLinksByDocument(documentId: DocumentId): readonly SourceLink[];
  listSourceLinksByDocuments(
    documentIds: readonly DocumentId[],
  ): readonly SourceLink[];
  listSourceLinksByMemo(memoId: MemoId): readonly SourceLink[];
  listSourceLinksByMemos(memoIds: readonly MemoId[]): readonly SourceLink[];
  /** ADR-003: with the memo's hard delete, in the same unit of work. Idempotent. */
  deleteSourceLinksByMemo(memoId: MemoId): void;

  /** Bulk `purgeAfter` recalculation after a retention change; no OCC, no `version` bump. */
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
