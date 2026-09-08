import { BusinessRuleError } from "@repo/core/domain/error";
import type { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import { KnowledgeErrorCode } from "./errorCode";
import {
  ChangeReason,
  DocumentBody,
  DocumentId,
  DocumentRevisionId,
  DocumentTitle,
  RevisionNumber,
  TopicDescription,
  TopicId,
  TopicName,
} from "./valueObject";

type TopicBase = Readonly<{
  id: TopicId;
  /** The identity of the Durable Object the topic lives in; never a row filter. */
  userId: UserId;
  name: TopicName;
  description: TopicDescription | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ActiveTopic = TopicBase & Readonly<{ status: "active" }>;
export type ArchivedTopic = TopicBase & Readonly<{ status: "archived" }>;
export type TrashedTopic = TopicBase &
  Readonly<{
    status: "trashed";
    trashedAt: Date;
    purgeAfter: Date;
    /** The state to come back to on restore. */
    wasArchived: boolean;
  }>;
export type Topic = ActiveTopic | ArchivedTopic | TrashedTopic;
/** Outside the trash: the receiver of most operations. */
export type LiveTopic = ActiveTopic | ArchivedTopic;

function describe(raw: string | null): TopicDescription | null {
  return raw === null ? null : TopicDescription.create(raw);
}

export const Topic = {
  create: (
    params: {
      id: string;
      userId: UserId;
      name: string;
      description: string | null;
    },
    now: Date,
  ): ActiveTopic => ({
    id: TopicId.create(params.id),
    userId: params.userId,
    name: TopicName.create(params.name),
    description: describe(params.description),
    version: 0,
    createdAt: now,
    updatedAt: now,
    status: "active",
  }),

  rename: <T extends LiveTopic>(topic: T, name: string, now: Date): T => ({
    ...topic,
    name: TopicName.create(name),
    version: topic.version + 1,
    updatedAt: now,
  }),

  changeDescription: <T extends LiveTopic>(
    topic: T,
    description: string | null,
    now: Date,
  ): T => ({
    ...topic,
    description: describe(description),
    version: topic.version + 1,
    updatedAt: now,
  }),

  archive: (topic: ActiveTopic, now: Date): ArchivedTopic => ({
    ...topic,
    status: "archived",
    version: topic.version + 1,
    updatedAt: now,
  }),

  unarchive: (topic: ArchivedTopic, now: Date): ActiveTopic => ({
    ...topic,
    status: "active",
    version: topic.version + 1,
    updatedAt: now,
  }),

  /** Only through `TopicTrashService.trashTopicSet`, together with the documents. */
  softDelete: (topic: LiveTopic, purgeAfter: Date, now: Date): TrashedTopic => {
    const { status, ...base } = topic;
    return {
      ...base,
      status: "trashed",
      trashedAt: now,
      purgeAfter,
      wasArchived: status === "archived",
      version: topic.version + 1,
      updatedAt: now,
    };
  },

  /** Only through `TopicTrashService.restoreTopicSet`. */
  restore: (topic: TrashedTopic, now: Date): LiveTopic => {
    const {
      status: _status,
      trashedAt: _trashedAt,
      purgeAfter: _purgeAfter,
      wasArchived,
      ...base
    } = topic;
    const version = topic.version + 1;
    return wasArchived
      ? { ...base, status: "archived", version, updatedAt: now }
      : { ...base, status: "active", version, updatedAt: now };
  },
};

type DocumentBase = Readonly<{
  id: DocumentId;
  userId: UserId;
  /** Every document belongs to a topic; only `moveToTopic` changes it (ADR-001). */
  topicId: TopicId;
  title: DocumentTitle;
  body: DocumentBody;
  /** Independent of `version`: a soft delete bumps `version` and not this. */
  latestRevision: RevisionNumber;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ActiveDocument = DocumentBase & Readonly<{ status: "active" }>;
export type TrashedDocument = DocumentBase &
  Readonly<{
    status: "trashed";
    trashedAt: Date;
    purgeAfter: Date;
    /** The topic it was trashed together with; `null` for an individual delete. */
    trashedWith: TopicId | null;
  }>;
export type Document = ActiveDocument | TrashedDocument;

/** Immutable snapshot: who, when, why and the full text at that point. */
export type DocumentRevision = Readonly<{
  id: DocumentRevisionId;
  documentId: DocumentId;
  revisionNumber: RevisionNumber;
  title: DocumentTitle;
  body: DocumentBody;
  actor: Actor;
  changeReason: ChangeReason;
  createdAt: Date;
}>;

/** Document → source memo. Points at the memo, not at a revision of it. */
export type SourceLink = Readonly<{
  documentId: DocumentId;
  memoId: MemoId;
  createdAt: Date;
}>;

export type DocumentWithRevision = Readonly<{
  document: ActiveDocument;
  revision: DocumentRevision;
}>;

export type DocumentEditOutcome =
  | Readonly<{ kind: "unchanged"; document: ActiveDocument }>
  | (Readonly<{ kind: "edited" }> & DocumentWithRevision);

function revise(
  document: ActiveDocument,
  next: { title: DocumentTitle; body: DocumentBody },
  params: { revisionId: string; actor: Actor; changeReason: string },
  now: Date,
): DocumentEditOutcome {
  const changeReason = ChangeReason.create(params.changeReason);
  const revisionId = DocumentRevisionId.create(params.revisionId);
  if (
    document.title === next.title &&
    DocumentBody.equals(document.body, next.body)
  ) {
    return { kind: "unchanged", document };
  }
  const revisionNumber = RevisionNumber.next(document.latestRevision);
  const edited: ActiveDocument = {
    ...document,
    title: next.title,
    body: next.body,
    latestRevision: revisionNumber,
    version: document.version + 1,
    updatedAt: now,
  };
  return {
    kind: "edited",
    document: edited,
    revision: {
      id: revisionId,
      documentId: document.id,
      revisionNumber,
      title: next.title,
      body: next.body,
      actor: params.actor,
      changeReason,
      createdAt: now,
    },
  };
}

export const Document = {
  /**
   * A document is born with revision #1 and its source links, the latter
   * de-duplicated. That the topic and the memos exist and are not in the
   * trash is the usecase's check, not this one's.
   */
  create: (
    params: {
      id: string;
      revisionId: string;
      userId: UserId;
      topicId: TopicId;
      title: string;
      body: string;
      actor: Actor;
      changeReason: string;
      sourceMemoIds: readonly MemoId[];
    },
    now: Date,
  ): {
    document: ActiveDocument;
    revision: DocumentRevision;
    sourceLinks: readonly SourceLink[];
  } => {
    const id = DocumentId.create(params.id);
    const title = DocumentTitle.create(params.title);
    const body = DocumentBody.create(params.body);
    const revisionNumber = RevisionNumber.first();
    const document: ActiveDocument = {
      id,
      userId: params.userId,
      topicId: params.topicId,
      title,
      body,
      latestRevision: revisionNumber,
      version: 0,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    const seen = new Set<MemoId>();
    const sourceLinks: SourceLink[] = [];
    for (const memoId of params.sourceMemoIds) {
      if (seen.has(memoId)) continue;
      seen.add(memoId);
      sourceLinks.push({ documentId: id, memoId, createdAt: now });
    }
    return {
      document,
      revision: {
        id: DocumentRevisionId.create(params.revisionId),
        documentId: id,
        revisionNumber,
        title,
        body,
        actor: params.actor,
        changeReason: ChangeReason.create(params.changeReason),
        createdAt: now,
      },
      sourceLinks,
    };
  },

  /** Receives the full text after any patch was applied; same text is `unchanged`. */
  edit: (
    document: ActiveDocument,
    params: {
      revisionId: string;
      title: string;
      body: string;
      actor: Actor;
      changeReason: string;
    },
    now: Date,
  ): DocumentEditOutcome =>
    revise(
      document,
      {
        title: DocumentTitle.create(params.title),
        body: DocumentBody.create(params.body),
      },
      params,
      now,
    ),

  /** A new revision carrying the target's title and body; history is kept. */
  rollback: (
    document: ActiveDocument,
    target: DocumentRevision,
    params: { revisionId: string; actor: Actor; changeReason: string },
    now: Date,
  ): DocumentEditOutcome => {
    if (target.documentId !== document.id) {
      throw new BusinessRuleError(
        KnowledgeErrorCode.RevisionDocumentMismatch,
        "The revision belongs to another document",
      );
    }
    return revise(
      document,
      { title: target.title, body: target.body },
      params,
      now,
    );
  },

  /** `trashedWith` is the topic of a set deletion; an individual delete passes `null`. */
  softDelete: (
    document: ActiveDocument,
    trashedWith: TopicId | null,
    purgeAfter: Date,
    now: Date,
  ): TrashedDocument => {
    if (trashedWith !== null && trashedWith !== document.topicId) {
      throw new BusinessRuleError(
        KnowledgeErrorCode.TrashedWithMismatch,
        "A document is only trashed together with its own topic",
      );
    }
    const { status: _status, ...base } = document;
    return {
      ...base,
      status: "trashed",
      trashedAt: now,
      purgeAfter,
      trashedWith,
      version: document.version + 1,
      updatedAt: now,
    };
  },

  /** The destination topic's existence outside the trash is the caller's to guarantee. */
  restore: (document: TrashedDocument, now: Date): ActiveDocument => {
    const {
      status: _status,
      trashedAt: _trashedAt,
      purgeAfter: _purgeAfter,
      trashedWith: _trashedWith,
      ...base
    } = document;
    return {
      ...base,
      status: "active",
      version: document.version + 1,
      updatedAt: now,
    };
  },

  /** ADR-001: re-home a trashed document whose topic is gone, right before `restore`. */
  moveToTopic: (
    document: TrashedDocument,
    destinationTopicId: TopicId,
    now: Date,
  ): TrashedDocument => ({
    ...document,
    topicId: destinationTopicId,
    trashedWith: null,
    version: document.version + 1,
    updatedAt: now,
  }),
};
