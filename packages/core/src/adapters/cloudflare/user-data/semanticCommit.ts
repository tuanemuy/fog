import type {
  SearchProjectionEntry,
  SemanticCommand,
  SemanticCommitPort,
} from "@repo/core/application/search/contracts";
import type { DurableSqlStorage } from "../sql";
import { Fts5SearchAdapter } from "./searchIndex";

export class UserDataSemanticCommit implements SemanticCommitPort {
  constructor(
    private readonly storage: DurableSqlStorage,
    private readonly retentionDays: () => number,
  ) {}

  commit(command: SemanticCommand): void {
    this.storage.transactionSync(() => {
      const duplicate = this.storage.sql
        .exec<{ result_json: string }>(
          "SELECT result_json FROM idempotency WHERE operation_id = ?",
          command.operationId,
        )
        .toArray()[0];
      if (duplicate) return;
      const projection = new Fts5SearchAdapter(this.storage.sql);
      switch (command.type) {
        case "upsert-content":
          this.upsertContent(command.entry);
          projection.apply({ type: "upsert", entry: command.entry });
          break;
        case "trash-content":
          this.trashContent(command.id, command.trashedAt);
          projection.apply({ type: "remove", id: command.id });
          break;
        case "restore-content": {
          this.restoreContent(command.id);
          const entry = this.readEntry(command.id);
          projection.apply({ type: "upsert", entry });
          break;
        }
        case "remove-content":
          this.removeContent(command.id);
          projection.apply({ type: "remove", id: command.id });
          break;
      }
      this.storage.sql.exec(
        `INSERT INTO idempotency(operation_id, result_json, completed_at)
         VALUES (?, '{"ok":true}', ?)`,
        command.operationId,
        Date.now(),
      );
    });
  }

  private upsertContent(entry: SearchProjectionEntry): void {
    this.storage.sql.exec(
      `INSERT INTO content(
         id, kind, title, body, topic_id, topic_archived, trashed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         body = excluded.body,
         topic_id = excluded.topic_id,
         topic_archived = excluded.topic_archived,
         trashed_at = excluded.trashed_at,
         updated_at = excluded.updated_at`,
      entry.id,
      entry.kind,
      entry.title,
      entry.body,
      entry.topicId ?? null,
      entry.topicArchived ? 1 : 0,
      entry.trashedAt ?? null,
      entry.updatedAt,
      entry.updatedAt,
    );
    this.storage.sql.exec(
      "DELETE FROM content_sources WHERE content_id = ?",
      entry.id,
    );
    for (const source of entry.sourceLinks) {
      this.storage.sql.exec(
        `INSERT INTO content_sources(content_id, memo_id, label)
         VALUES (?, ?, ?)`,
        entry.id,
        source.memoId,
        source.label,
      );
    }
  }

  private trashContent(id: string, trashedAt: number): void {
    const row = this.storage.sql
      .exec<{ kind: string }>("SELECT kind FROM content WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new Error("CONTENT_NOT_FOUND");
    this.storage.sql.exec(
      "UPDATE content SET trashed_at = ?, updated_at = ? WHERE id = ?",
      trashedAt,
      trashedAt,
      id,
    );
    this.storage.sql.exec(
      `INSERT INTO trash(content_id, content_kind, trashed_at, purge_after)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(content_id) DO UPDATE SET
         trashed_at = excluded.trashed_at,
         purge_after = excluded.purge_after`,
      id,
      row.kind,
      trashedAt,
      trashedAt + this.retentionDays() * 86_400_000,
    );
  }

  private restoreContent(id: string): void {
    this.storage.sql.exec(
      "UPDATE content SET trashed_at = NULL WHERE id = ?",
      id,
    );
    this.storage.sql.exec("DELETE FROM trash WHERE content_id = ?", id);
  }

  private removeContent(id: string): void {
    this.storage.sql.exec(
      "DELETE FROM content_sources WHERE content_id = ?",
      id,
    );
    this.storage.sql.exec(
      "DELETE FROM content_revisions WHERE content_id = ?",
      id,
    );
    this.storage.sql.exec("DELETE FROM trash WHERE content_id = ?", id);
    this.storage.sql.exec("DELETE FROM content WHERE id = ?", id);
  }

  private readEntry(id: string): SearchProjectionEntry {
    const row = this.storage.sql
      .exec<{
        id: string;
        kind: "memo" | "document";
        title: string;
        body: string;
        topic_id: string | null;
        topic_archived: number;
        trashed_at: number | null;
        updated_at: number;
      }>("SELECT * FROM content WHERE id = ?", id)
      .one();
    const sourceLinks = this.storage.sql
      .exec<{ memo_id: string; label: string }>(
        "SELECT memo_id, label FROM content_sources WHERE content_id = ?",
        id,
      )
      .toArray()
      .map((source) => ({ memoId: source.memo_id, label: source.label }));
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      topicArchived: row.topic_archived === 1,
      sourceLinks,
      ...(row.trashed_at === null ? {} : { trashedAt: row.trashed_at }),
      updatedAt: row.updated_at,
    };
  }
}
