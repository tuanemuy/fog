import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ExportSourceDto } from "@repo/core/application/export/gateway";
import type { Logger } from "@repo/core/application/ports/logger";

/**
 * The request-side byte cap on one export's snapshot (design D-15 △-1):
 * three quarters of the 32 MiB a Workers RPC message may carry, leaving
 * room for the frontmatter and the serialisation itself.
 */
export const EXPORT_MAX_SOURCE_BYTES = 24 * 1024 * 1024;

type MemoRow = Readonly<{
  id: string;
  body: string;
  posted_at: number;
  updated_at: number;
}>;
type TopicRow = Readonly<{
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: number;
}>;
type DocumentRow = Readonly<{
  id: string;
  topic_id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}>;
type LinkRow = Readonly<{ document_id: string; memo_id: string }>;

/**
 * `ExportSourceReader` on the object's own SQLite, as the DTO the RPC
 * carries. Run inside one `transactionSync` by the facade so the four
 * reads see one snapshot. Every row it returns is live: trashed memos,
 * documents and topics are filtered by `status`, each body is the row's
 * own (the latest revision), and `source_links` cascades on a memo's hard
 * delete, so a hard-deleted source is already absent (ADR-003) while a
 * trashed one stays for the renderer to mark `deleted: true`.
 *
 * The cap is checked first, on the UTF-8 length of every text column the
 * archive will carry, before any body is copied out of storage.
 */
export function readExportSourceDto(
  sql: SqlStorage,
  maxBytes: number,
  logger?: Logger,
): ExportSourceDto {
  const size = sql
    .exec<{ bytes: number | null }>(
      `SELECT
         (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM memos WHERE status = 'active')
       + (SELECT COALESCE(SUM(length(CAST(body AS BLOB)) + length(CAST(title AS BLOB))), 0) FROM documents WHERE status = 'active')
       + (SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(COALESCE(description, '') AS BLOB))), 0) FROM topics WHERE status IN ('active', 'archived'))
       AS bytes`,
    )
    .one().bytes;
  const bytes = size ?? 0;
  if (bytes > maxBytes) {
    logger?.warn("export refused: snapshot over the byte cap", {
      bytes,
      maxBytes,
    });
    throw new SystemError(
      SystemErrorCode.ExportTooLarge,
      "The export exceeds the size limit",
    );
  }

  const memos = sql
    .exec<MemoRow>(
      "SELECT id, body, posted_at, updated_at FROM memos WHERE status = 'active' ORDER BY posted_at ASC, id ASC",
    )
    .toArray();
  const topics = sql
    .exec<TopicRow>(
      "SELECT id, name, description, status, created_at FROM topics WHERE status IN ('active', 'archived') ORDER BY created_at ASC, id ASC",
    )
    .toArray();
  const documents = sql
    .exec<DocumentRow>(
      "SELECT id, topic_id, title, body, created_at, updated_at FROM documents WHERE status = 'active' ORDER BY created_at ASC, id ASC",
    )
    .toArray();
  const links = sql
    .exec<LinkRow>(
      "SELECT sl.document_id, sl.memo_id FROM source_links sl JOIN documents d ON d.id = sl.document_id WHERE d.status = 'active' ORDER BY sl.document_id ASC, sl.created_at ASC, sl.memo_id ASC",
    )
    .toArray();
  const sourcesByDocument = new Map<string, string[]>();
  for (const link of links) {
    const bucket = sourcesByDocument.get(link.document_id);
    if (bucket === undefined)
      sourcesByDocument.set(link.document_id, [link.memo_id]);
    else bucket.push(link.memo_id);
  }

  return {
    memos: memos.map((m) => ({
      memoId: m.id,
      content: m.body,
      postedAt: m.posted_at,
      updatedAt: m.updated_at,
    })),
    topics: topics.map((t) => ({
      topicId: t.id,
      name: t.name,
      description: t.description,
      archived: t.status === "archived",
      createdAt: t.created_at,
    })),
    documents: documents.map((d) => ({
      documentId: d.id,
      topicId: d.topic_id,
      title: d.title,
      content: d.body,
      sourceMemoIds: sourcesByDocument.get(d.id) ?? [],
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
  };
}
