import type { InValue, Transaction } from "@libsql/client";
import { ConflictError, NotFoundError } from "@repo/core/application/errors";
import type {
  ContentKind,
  ContentRef,
  TrashRecord,
} from "@repo/core/application/fog/dataTypes";
import type {
  DataRepository,
  SearchKey,
  SearchRow,
} from "@repo/core/application/fog/ports";
import { z } from "zod";

const tables: Record<ContentKind, string> = {
  memo: "fog_memos",
  document: "fog_documents",
  topic: "fog_topics",
};
const trashSchema = z.object({
  kind: z.enum(["memo", "document", "topic"]),
  id: z.string(),
  title: z.string(),
  body: z.string(),
  deletedAt: z.string(),
  deletionGroupId: z.string().nullable(),
  topicId: z.string().nullable(),
  topicTitle: z.string().nullable(),
  topicDeletedAt: z.string().nullable(),
  topicGroup: z.string().nullable(),
});
const searchSchema = z.object({
  kind: z.enum(["memo", "document"]),
  id: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  topicId: z.string().nullable(),
  topicTitle: z.string().nullable(),
});
const idSchema = z.object({ id: z.string() });
async function rows<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  return (await tx.execute({ sql, args })).rows.map((row) => schema.parse(row));
}
export class LibsqlDataRepository implements DataRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly ownerId: string,
  ) {}
  async trash(): Promise<TrashRecord[]> {
    const results = await rows(
      this.tx,
      `
      SELECT 'memo' kind,id,substr(body,1,80) title,body,deleted_at deletedAt,deletion_group deletionGroupId,NULL topicId,NULL topicTitle,NULL topicDeletedAt,NULL topicGroup FROM fog_memos WHERE owner_id=? AND deleted_at IS NOT NULL
      UNION ALL SELECT 'topic',id,title,description,deleted_at,deletion_group,NULL,NULL,NULL,NULL FROM fog_topics WHERE owner_id=? AND deleted_at IS NOT NULL
      UNION ALL SELECT 'document',d.id,d.title,d.body,d.deleted_at,d.deletion_group,t.id,t.title,t.deleted_at,t.deletion_group FROM fog_documents d LEFT JOIN fog_topics t ON t.id=d.topic_id AND t.owner_id=d.owner_id WHERE d.owner_id=? AND d.deleted_at IS NOT NULL
      ORDER BY deletedAt DESC,id DESC,kind DESC`,
      [this.ownerId, this.ownerId, this.ownerId],
      trashSchema,
    );
    return results.map(
      ({
        kind,
        topicId,
        topicTitle,
        topicDeletedAt,
        topicGroup,
        ...item
      }): TrashRecord => {
        const group = kind === "document" ? topicGroup : item.deletionGroupId;
        const setDocumentIds =
          kind === "memo" || !group
            ? []
            : results
                .filter(
                  (row) =>
                    row.kind === "document" && row.deletionGroupId === group,
                )
                .map((row) => row.id);
        if (kind === "document")
          return {
            ...item,
            kind,
            setDocumentIds,
            topic:
              topicId && topicTitle !== null
                ? {
                    kind: topicDeletedAt ? "deleted" : "active",
                    id: topicId,
                    title: topicTitle,
                  }
                : { kind: "missing" },
          };
        return { ...item, kind, setDocumentIds, topic: null };
      },
    );
  }
  async findTrash(ref: ContentRef) {
    return (
      (await this.trash()).find(
        (item) => item.id === ref.id && item.kind === ref.kind,
      ) ?? null
    );
  }
  async softDelete(
    ref: ContentRef,
    expectedVersion: number,
    deletedAt: string,
    group: string,
  ) {
    const result = await this.tx.execute({
      sql: `UPDATE ${tables[ref.kind]} SET deleted_at=?,deletion_group=? WHERE owner_id=? AND id=? AND version=? AND deleted_at IS NULL`,
      args: [deletedAt, group, this.ownerId, ref.id, expectedVersion],
    });
    if (result.rowsAffected !== 1)
      throw new ConflictError(
        "OPTIMISTIC_LOCK_FAILURE",
        "内容が更新されました。確認してください。",
      );
    if (ref.kind === "topic")
      await this.tx.execute({
        sql: "UPDATE fog_documents SET deleted_at=?,deletion_group=? WHERE owner_id=? AND topic_id=? AND deleted_at IS NULL",
        args: [deletedAt, group, this.ownerId, ref.id],
      });
  }
  async restore(ref: ContentRef, topicId?: string) {
    if (ref.kind === "topic") {
      const item = await this.findTrash(ref);
      if (!item) return;
      await this.tx.execute({
        sql: "UPDATE fog_documents SET deleted_at=NULL,deletion_group=NULL WHERE owner_id=? AND topic_id=? AND deleted_at IS NOT NULL AND deletion_group=?",
        args: [this.ownerId, ref.id, item.deletionGroupId],
      });
    }
    await this.tx.execute({
      sql: `UPDATE ${tables[ref.kind]} SET deleted_at=NULL,deletion_group=NULL${ref.kind === "document" && topicId ? ",topic_id=?" : ""} WHERE owner_id=? AND id=? AND deleted_at IS NOT NULL`,
      args: [
        ...(ref.kind === "document" && topicId ? [topicId] : []),
        this.ownerId,
        ref.id,
      ],
    });
  }
  async hardDelete(ref: ContentRef): Promise<number> {
    let count = 0;
    if (ref.kind === "topic") {
      const item = await this.findTrash(ref);
      if (!item) return 0;
      count += (
        await this.tx.execute({
          sql: "DELETE FROM fog_documents WHERE owner_id=? AND topic_id=? AND deleted_at IS NOT NULL AND deletion_group=?",
          args: [this.ownerId, ref.id, item.deletionGroupId],
        })
      ).rowsAffected;
      await this.tx.execute({
        sql: "UPDATE fog_documents SET topic_id=NULL WHERE owner_id=? AND topic_id=? AND deleted_at IS NOT NULL",
        args: [this.ownerId, ref.id],
      });
    }
    count += (
      await this.tx.execute({
        sql: `DELETE FROM ${tables[ref.kind]} WHERE owner_id=? AND id=? AND deleted_at IS NOT NULL`,
        args: [this.ownerId, ref.id],
      })
    ).rowsAffected;
    return count;
  }
  async retentionDays(): Promise<number> {
    const result = await rows(
      this.tx,
      "SELECT retention_days days FROM fog_users WHERE id=?",
      [this.ownerId],
      z.object({ days: z.number().int().positive() }),
    );
    if (!result[0])
      throw new NotFoundError("USER_NOT_FOUND", "利用者が見つかりません。");
    return result[0].days;
  }
  async setRetentionDays(days: number) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_users SET retention_days=? WHERE id=?",
      args: [days, this.ownerId],
    });
    if (result.rowsAffected !== 1)
      throw new NotFoundError("USER_NOT_FOUND", "利用者が見つかりません。");
  }
  search(input: {
    query: string;
    topicId?: string;
    limit: number;
    before?: SearchKey;
  }): Promise<SearchRow[]> {
    const args: InValue[] = [this.ownerId, input.query];
    const memoScope = input.topicId
      ? " AND m.id IN (SELECT s.memo_id FROM fog_document_sources s JOIN fog_documents d ON d.id=s.document_id AND d.owner_id=s.owner_id WHERE s.owner_id=m.owner_id AND d.topic_id=? AND d.deleted_at IS NULL)"
      : "";
    if (input.topicId) args.push(input.topicId);
    args.push(this.ownerId, input.query, input.query);
    if (input.topicId) args.push(input.topicId);
    const before = input.before;
    if (before)
      args.push(
        before.createdAt,
        before.createdAt,
        before.id,
        before.createdAt,
        before.id,
        before.kind,
      );
    args.push(input.limit);
    return rows(
      this.tx,
      `SELECT * FROM (
      SELECT 'memo' kind,m.id,NULL title,m.body,m.created_at createdAt,m.updated_at updatedAt,NULL topicId,NULL topicTitle FROM fog_memos m WHERE m.owner_id=? AND m.deleted_at IS NULL AND instr(lower(m.body),lower(?))>0${memoScope}
      UNION ALL SELECT 'document',d.id,d.title,d.body,d.created_at,d.updated_at,t.id,t.title FROM fog_documents d JOIN fog_topics t ON t.id=d.topic_id AND t.owner_id=d.owner_id WHERE d.owner_id=? AND d.deleted_at IS NULL AND t.deleted_at IS NULL AND (instr(lower(d.title),lower(?))>0 OR instr(lower(d.body),lower(?))>0)${input.topicId ? " AND d.topic_id=?" : ""}
    ) ${before ? "WHERE createdAt<? OR (createdAt=? AND id<?) OR (createdAt=? AND id=? AND kind<?)" : ""} ORDER BY createdAt DESC,id DESC,kind DESC LIMIT ?`,
      args,
      searchSchema,
    );
  }
  async sourceIds(ref: ContentRef): Promise<string[]> {
    if (ref.kind === "topic") return [];
    const sql =
      ref.kind === "memo"
        ? "SELECT d.id FROM fog_document_sources s JOIN fog_documents d ON d.id=s.document_id AND d.owner_id=s.owner_id JOIN fog_topics t ON t.id=d.topic_id AND t.owner_id=d.owner_id WHERE s.owner_id=? AND s.memo_id=? AND d.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY d.id"
        : "SELECT m.id FROM fog_document_sources s JOIN fog_memos m ON m.id=s.memo_id AND m.owner_id=s.owner_id WHERE s.owner_id=? AND s.document_id=? AND m.deleted_at IS NULL ORDER BY m.id";
    return (await rows(this.tx, sql, [this.ownerId, ref.id], idSchema)).map(
      (row) => row.id,
    );
  }
}
