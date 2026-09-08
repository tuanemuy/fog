import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import { createDocumentRepository } from "@repo/core/adapters/cloudflare/stores/documentRepository";
import type { RequestContainer } from "@repo/core/application/di/types";
import { createDocument } from "@repo/core/application/knowledge/createDocument";
import { createTopic } from "@repo/core/application/knowledge/createTopic";
import type {
  CreateDocumentView,
  TopicView,
} from "@repo/core/application/knowledge/view";
import {
  Actor,
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { Document } from "@repo/core/domain/knowledge/entity";
import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import { userActor } from "../../memo/__tests__/memoFixtures";

export { expectCode, post, userActor } from "../../memo/__tests__/memoFixtures";

export function topic(
  container: RequestContainer,
  userId: string,
  name = "読書メモ",
  description: string | null = null,
): Promise<TopicView> {
  return createTopic({ container, input: { userId, name, description } });
}

export function document(
  container: RequestContainer,
  userId: string,
  topicId: string,
  overrides: Partial<{
    title: string;
    body: string;
    sourceMemoIds: readonly string[];
    changeReason: string | null;
  }> = {},
): Promise<CreateDocumentView> {
  return createDocument({
    container,
    input: {
      userId,
      actor: userActor(userId),
      topicId,
      title: overrides.title ?? "タイトル",
      body: overrides.body ?? "本文",
      sourceMemoIds: overrides.sourceMemoIds ?? [],
      changeReason: overrides.changeReason ?? null,
    },
  });
}

/**
 * An edit by an AI client, written the way `editDocumentByAi` (PH-07) will
 * write it, so a conflict answer and a history row carry a client name today.
 */
export function editDocumentAsAiClient(
  userId: string,
  documentId: string,
  body: string,
  clientName: string,
  changeReason = "AI による編集",
): Promise<void> {
  return inUserDataStorage(userId, (sql, _instance, state) => {
    const repository = createDocumentRepository(sql, userId);
    const found = repository.findById(DocumentId.create(documentId));
    if (found === null) throw new Error("the document to edit is missing");
    const actor = Actor.aiClient(
      UserId.create(userId),
      AiClientConnectionId.create("connection-1"),
      ClientName.create(clientName),
    );
    const outcome = Document.edit(
      found.entity,
      {
        revisionId: `ai-${documentId}-${found.entity.latestRevision + 1}`,
        title: found.entity.title,
        body,
        actor,
        changeReason,
      },
      new Date(),
    );
    if (outcome.kind !== "edited")
      throw new Error("the AI edit changed nothing");
    state.storage.transactionSync(() => {
      repository.save(outcome.document, found.expectedVersion);
      repository.insertRevision(outcome.revision);
    });
  });
}

export type DocumentRowSnapshot = Readonly<{
  status: string;
  version: number;
  title: string;
  body: string;
  latest_revision_number: number;
  topic_id: string;
  trashed_at: number | null;
  purge_after: number | null;
  trashed_with: string | null;
}>;

export function readDocumentRow(
  userId: string,
  documentId: string,
): Promise<DocumentRowSnapshot | undefined> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<DocumentRowSnapshot>(
          "SELECT status, version, title, body, latest_revision_number, topic_id, trashed_at, purge_after, trashed_with FROM documents WHERE id = ?",
          documentId,
        )
        .toArray()[0],
  );
}

export type TopicRowSnapshot = Readonly<{
  status: string;
  version: number;
  name: string;
  description: string | null;
  trashed_at: number | null;
  purge_after: number | null;
  was_archived: number | null;
}>;

export function readTopicRow(
  userId: string,
  topicId: string,
): Promise<TopicRowSnapshot | undefined> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<TopicRowSnapshot>(
          "SELECT status, version, name, description, trashed_at, purge_after, was_archived FROM topics WHERE id = ?",
          topicId,
        )
        .toArray()[0],
  );
}

export function revisionRows(
  userId: string,
  documentId: string,
): Promise<
  {
    revision_number: number;
    actor_type: string;
    change_reason: string;
    body: string;
  }[]
> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<{
        revision_number: number;
        actor_type: string;
        change_reason: string;
        body: string;
      }>(
        "SELECT revision_number, actor_type, change_reason, body FROM document_revisions WHERE document_id = ? ORDER BY revision_number",
        documentId,
      )
      .toArray(),
  );
}

/** `search_entries` for one id: `source_ids` parsed, `null` when absent. */
export function searchEntry(
  userId: string,
  id: string,
): Promise<{
  type: string;
  topicId: string | null;
  title: string;
  sourceIds: string[];
} | null> {
  return inUserDataStorage(userId, (sql) => {
    const row = sql
      .exec<{
        type: string;
        topic_id: string | null;
        title: string;
        source_ids: string;
      }>(
        "SELECT type, topic_id, title, source_ids FROM search_entries WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row
      ? {
          type: row.type,
          topicId: row.topic_id,
          title: row.title,
          sourceIds: JSON.parse(row.source_ids) as string[],
        }
      : null;
  });
}

/** The FTS hits for `term`, as ids. */
export function ftsHits(userId: string, term: string): Promise<string[]> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<{ id: string }>(
        "SELECT e.id FROM search_fts f JOIN search_entries e ON e.rowid = f.rowid WHERE search_fts MATCH ?",
        term,
      )
      .toArray()
      .map((row) => row.id)
      .sort(),
  );
}

export function purgeJobNextRunAt(userId: string): Promise<number | null> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<{ next_run_at: number | null }>(
          "SELECT next_run_at FROM jobs WHERE kind = 'purge-trash'",
        )
        .toArray()[0]?.next_run_at ?? null,
  );
}
