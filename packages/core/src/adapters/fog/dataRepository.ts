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
  purging: z.number().int().transform(Boolean),
  topicId: z.string().nullable(),
  topicTitle: z.string().nullable(),
  topicDeletedAt: z.string().nullable(),
  topicGroup: z.string().nullable(),
  topicPurging: z.number().int().nullable().transform(Boolean),
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
      SELECT 'memo' kind,id,substr(body,1,80) title,body,deleted_at deletedAt,deletion_group deletionGroupId,purging,NULL topicId,NULL topicTitle,NULL topicDeletedAt,NULL topicGroup,NULL topicPurging FROM fog_memos WHERE owner_id=? AND deleted_at IS NOT NULL
      UNION ALL SELECT 'topic',t.id,t.title,t.description,t.deleted_at,t.deletion_group,
        CASE WHEN t.purging=1 OR EXISTS (SELECT 1 FROM fog_documents d WHERE d.owner_id=t.owner_id AND d.topic_id=t.id AND d.purging=1) THEN 1 ELSE 0 END,
        NULL,NULL,NULL,NULL,NULL FROM fog_topics t WHERE t.owner_id=? AND t.deleted_at IS NOT NULL
      UNION ALL SELECT 'document',d.id,d.title,d.body,d.deleted_at,d.deletion_group,d.purging,t.id,t.title,t.deleted_at,t.deletion_group,t.purging FROM fog_documents d LEFT JOIN fog_topics t ON t.id=d.topic_id AND t.owner_id=d.owner_id WHERE d.owner_id=? AND d.deleted_at IS NOT NULL
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
        topicPurging,
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
                    kind: topicPurging
                      ? "purging"
                      : topicDeletedAt
                        ? "deleted"
                        : "active",
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
    const item = await this.findTrash(ref);
    if (!item) return;
    if (item.purging)
      throw new ConflictError(
        "PURGE_IN_PROGRESS",
        "完全削除を開始した項目は復元できません。",
      );
    if (ref.kind === "topic") {
      const blocked = await this.tx.execute({
        sql: "SELECT 1 FROM fog_documents WHERE owner_id=? AND topic_id=? AND purging=1 LIMIT 1",
        args: [this.ownerId, ref.id],
      });
      if (blocked.rows.length > 0)
        throw new ConflictError(
          "PURGE_IN_PROGRESS",
          "配下の完全削除を開始したため、このトピックは復元できません。",
        );
      await this.tx.execute({
        sql: "UPDATE fog_documents SET deleted_at=NULL,deletion_group=NULL WHERE owner_id=? AND topic_id=? AND deleted_at IS NOT NULL AND purging=0 AND deletion_group=?",
        args: [this.ownerId, ref.id, item.deletionGroupId],
      });
    }
    const result = await this.tx.execute({
      sql: `UPDATE ${tables[ref.kind]} SET deleted_at=NULL,deletion_group=NULL${ref.kind === "document" && topicId ? ",topic_id=?" : ""} WHERE owner_id=? AND id=? AND deleted_at IS NOT NULL AND purging=0`,
      args: [
        ...(ref.kind === "document" && topicId ? [topicId] : []),
        this.ownerId,
        ref.id,
      ],
    });
    if (result.rowsAffected !== 1)
      throw new ConflictError(
        "PURGE_IN_PROGRESS",
        "完全削除が開始されたため復元できません。",
      );
  }
  async deleteTrashBatch({
    deletedBefore,
    limitPerKind,
    target,
  }: {
    deletedBefore?: string;
    limitPerKind: number;
    target?: ContentRef;
  }): Promise<{ deletedCount: number; processedRowCount: number }> {
    if (!Number.isInteger(limitPerKind) || limitPerKind < 1)
      throw new Error("Trash batch limit must be a positive integer");
    const cutoff = (alias: string) =>
      deletedBefore ? ` AND ${alias}.deleted_at<=?` : "";
    const cutoffArgs = (): InValue[] => (deletedBefore ? [deletedBefore] : []);
    let remaining = limitPerKind;
    let deletedCount = 0;
    let processedRowCount = 0;
    const execute = async (
      sql: string,
      args: InValue[],
      countAsItem = false,
    ) => {
      if (remaining === 0) return;
      const result = await this.tx.execute({
        sql,
        args: [...args, remaining],
      });
      remaining -= result.rowsAffected;
      processedRowCount += result.rowsAffected;
      if (countAsItem) deletedCount += result.rowsAffected;
    };

    if (target?.kind === "topic")
      await execute(
        `UPDATE fog_topics SET purging=1 WHERE rowid IN (
          SELECT t.rowid FROM fog_topics t WHERE t.owner_id=? AND t.id=? AND t.deleted_at IS NOT NULL AND t.purging=0 LIMIT ?
        )`,
        [this.ownerId, target.id],
      );
    else if (!target)
      await execute(
        `UPDATE fog_topics SET purging=1 WHERE rowid IN (
          SELECT t.rowid FROM fog_topics t WHERE t.owner_id=? AND t.deleted_at IS NOT NULL AND t.purging=0${cutoff("t")}
          ORDER BY t.deleted_at,t.id LIMIT ?
        )`,
        [this.ownerId, ...cutoffArgs()],
      );

    await execute(
      `DELETE FROM fog_document_sources WHERE rowid IN (
        SELECT s.rowid FROM fog_document_sources s
        WHERE s.owner_id=? AND (
          EXISTS (SELECT 1 FROM fog_documents d WHERE d.owner_id=s.owner_id AND d.id=s.document_id AND d.purging=1${cutoff("d")})
          OR EXISTS (SELECT 1 FROM fog_memos m WHERE m.owner_id=s.owner_id AND m.id=s.memo_id AND m.purging=1${cutoff("m")})
        ) ORDER BY s.document_id,s.memo_id LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs(), ...cutoffArgs()],
    );
    await execute(
      `DELETE FROM fog_memo_revisions WHERE rowid IN (
        SELECT r.rowid FROM fog_memo_revisions r JOIN fog_memos m
          ON m.owner_id=r.owner_id AND m.id=r.memo_id
        WHERE r.owner_id=? AND m.purging=1${cutoff("m")}
        ORDER BY r.memo_id,r.version LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs()],
    );
    await execute(
      `DELETE FROM fog_document_revisions WHERE rowid IN (
        SELECT r.rowid FROM fog_document_revisions r JOIN fog_documents d
          ON d.owner_id=r.owner_id AND d.id=r.document_id
        WHERE r.owner_id=? AND d.purging=1${cutoff("d")}
        ORDER BY r.document_id,r.version LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs()],
    );
    await execute(
      `DELETE FROM fog_documents WHERE rowid IN (
        SELECT d.rowid FROM fog_documents d WHERE d.owner_id=? AND d.purging=1${cutoff("d")}
          AND NOT EXISTS (SELECT 1 FROM fog_document_revisions r WHERE r.owner_id=d.owner_id AND r.document_id=d.id)
          AND NOT EXISTS (SELECT 1 FROM fog_document_sources s WHERE s.owner_id=d.owner_id AND s.document_id=d.id)
        ORDER BY d.deleted_at,d.id LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs()],
      true,
    );
    await execute(
      `DELETE FROM fog_memos WHERE rowid IN (
        SELECT m.rowid FROM fog_memos m WHERE m.owner_id=? AND m.purging=1${cutoff("m")}
          AND NOT EXISTS (SELECT 1 FROM fog_memo_revisions r WHERE r.owner_id=m.owner_id AND r.memo_id=m.id)
          AND NOT EXISTS (SELECT 1 FROM fog_document_sources s WHERE s.owner_id=m.owner_id AND s.memo_id=m.id)
        ORDER BY m.deleted_at,m.id LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs()],
      true,
    );
    if (target?.kind === "topic") {
      await execute(
        `UPDATE fog_documents SET topic_id=NULL WHERE rowid IN (
          SELECT d.rowid FROM fog_documents d JOIN fog_topics t
            ON t.owner_id=d.owner_id AND t.id=d.topic_id
          WHERE d.owner_id=? AND t.id=? AND t.purging=1 AND d.deleted_at IS NOT NULL AND d.purging=0
            AND NOT (d.deletion_group IS t.deletion_group)
          ORDER BY d.deleted_at,d.id LIMIT ?
        )`,
        [this.ownerId, target.id],
      );
    }
    await execute(
      `DELETE FROM fog_topics WHERE rowid IN (
        SELECT t.rowid FROM fog_topics t WHERE t.owner_id=? AND t.purging=1${cutoff("t")}
          AND NOT EXISTS (SELECT 1 FROM fog_documents d WHERE d.owner_id=t.owner_id AND d.topic_id=t.id)
        ORDER BY t.deleted_at,t.id LIMIT ?
      )`,
      [this.ownerId, ...cutoffArgs()],
      true,
    );
    if (target?.kind === "document")
      await execute(
        `UPDATE fog_documents SET purging=1 WHERE rowid IN (
          SELECT d.rowid FROM fog_documents d WHERE d.owner_id=? AND d.id=? AND d.deleted_at IS NOT NULL AND d.purging=0 LIMIT ?
        )`,
        [this.ownerId, target.id],
      );
    else if (target?.kind === "memo")
      await execute(
        `UPDATE fog_memos SET purging=1 WHERE rowid IN (
          SELECT m.rowid FROM fog_memos m WHERE m.owner_id=? AND m.id=? AND m.deleted_at IS NOT NULL AND m.purging=0 LIMIT ?
        )`,
        [this.ownerId, target.id],
      );
    else if (target?.kind === "topic")
      await execute(
        `UPDATE fog_documents SET purging=1 WHERE rowid IN (
          SELECT d.rowid FROM fog_documents d JOIN fog_topics t
            ON t.owner_id=d.owner_id AND t.id=d.topic_id
          WHERE d.owner_id=? AND t.id=? AND d.deleted_at IS NOT NULL AND d.purging=0
            AND d.deletion_group IS t.deletion_group
          ORDER BY d.deleted_at,d.id LIMIT ?
        )`,
        [this.ownerId, target.id],
      );
    else
      for (const table of ["fog_documents", "fog_memos"] as const)
        await execute(
          `UPDATE ${table} SET purging=1 WHERE rowid IN (
            SELECT c.rowid FROM ${table} c WHERE c.owner_id=? AND c.deleted_at IS NOT NULL AND c.purging=0${cutoff("c")}
            ORDER BY c.deleted_at,c.id LIMIT ?
          )`,
          [this.ownerId, ...cutoffArgs()],
        );
    return { deletedCount, processedRowCount };
  }
  async purgeTargetCount(ref: ContentRef): Promise<number> {
    if (ref.kind !== "topic") {
      const result = await this.tx.execute({
        sql: `SELECT count(*) count FROM ${tables[ref.kind]} WHERE owner_id=? AND id=? AND deleted_at IS NOT NULL`,
        args: [this.ownerId, ref.id],
      });
      return Number(result.rows[0]?.count ?? 0);
    }
    const result = await this.tx.execute({
      sql: `SELECT
        (SELECT count(*) FROM fog_topics t WHERE t.owner_id=? AND t.id=? AND t.deleted_at IS NOT NULL)
        + (SELECT count(*) FROM fog_documents d JOIN fog_topics t ON t.owner_id=d.owner_id AND t.id=d.topic_id
           WHERE t.owner_id=? AND t.id=? AND d.deleted_at IS NOT NULL AND d.deletion_group IS t.deletion_group) count`,
      args: [this.ownerId, ref.id, this.ownerId, ref.id],
    });
    return Number(result.rows[0]?.count ?? 0);
  }
  async isPurgeTargetActive(ref: ContentRef): Promise<boolean> {
    const result = await this.tx.execute({
      sql: `SELECT 1 FROM ${tables[ref.kind]} WHERE owner_id=? AND id=? AND deleted_at IS NULL LIMIT 1`,
      args: [this.ownerId, ref.id],
    });
    return result.rows.length > 0;
  }
  async trashCount(): Promise<{
    restorableCount: number;
    purgingCount: number;
  }> {
    const result = await this.tx.execute({
      sql: `SELECT
        coalesce(sum(CASE WHEN purging=0 THEN 1 ELSE 0 END),0) restorableCount,
        coalesce(sum(CASE WHEN purging=1 THEN 1 ELSE 0 END),0) purgingCount
      FROM (
        SELECT purging FROM fog_memos WHERE owner_id=? AND deleted_at IS NOT NULL
        UNION ALL SELECT purging FROM fog_documents WHERE owner_id=? AND deleted_at IS NOT NULL
        UNION ALL SELECT purging FROM fog_topics WHERE owner_id=? AND deleted_at IS NOT NULL
      )`,
      args: [this.ownerId, this.ownerId, this.ownerId],
    });
    const row = result.rows[0];
    return {
      restorableCount: Number(row?.restorableCount ?? 0),
      purgingCount: Number(row?.purgingCount ?? 0),
    };
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
