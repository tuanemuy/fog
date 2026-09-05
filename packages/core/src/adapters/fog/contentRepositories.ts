import type { InValue, Transaction } from "@libsql/client";
import { ConflictError } from "@repo/core/application/errors";
import type {
  DocumentRepository,
  MemoRepository,
  TopicRepository,
} from "@repo/core/application/fog/ports";
import type {
  Actor,
  Document,
  Memo,
  TimelineKey,
  Topic,
} from "@repo/core/domain/fog/content";
import { z } from "zod";

const baseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
const memoSchema = baseSchema.extend({ body: z.string() });
const topicSchema = baseSchema.extend({
  title: z.string(),
  description: z.string(),
  completed: z.number().transform((value) => value === 1),
});
const documentSchema = baseSchema.extend({
  topicId: z.string(),
  title: z.string(),
  body: z.string(),
});
const memoColumns =
  "id,owner_id AS ownerId,body,created_at AS createdAt,updated_at AS updatedAt,version";
const topicColumns =
  "id,owner_id AS ownerId,title,description,completed,created_at AS createdAt,updated_at AS updatedAt,version";
const documentColumns =
  "id,owner_id AS ownerId,topic_id AS topicId,title,body,created_at AS createdAt,updated_at AS updatedAt,version";
const revisionSchema = z.object({
  version: z.number(),
  body: z.string(),
  createdAt: z.string(),
  actorKind: z.enum(["human", "ai"]),
  actorId: z.string(),
  actorName: z.string(),
});
const revisionColumns =
  "version,body,created_at AS createdAt,actor_kind AS actorKind,actor_id AS actorId,actor_name AS actorName";
const revisionView = ({
  actorKind,
  actorId,
  actorName,
  ...rest
}: z.infer<typeof revisionSchema>) => ({
  ...rest,
  actor: { kind: actorKind, id: actorId, name: actorName },
});
const actorValues = (actor: Actor): InValue[] => [
  actor.kind,
  actor.kind === "human" ? actor.userId : actor.clientId,
  actor.kind === "human" ? actor.email : actor.clientName,
];
const conflict = () =>
  new ConflictError(
    "OPTIMISTIC_LOCK_FAILURE",
    "編集中に内容が更新されました。最新の内容を確認してください。",
  );
async function rows<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  return (await tx.execute({ sql, args })).rows.map((row) => schema.parse(row));
}
async function one<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T | null> {
  return (await rows(tx, sql, args, schema))[0] ?? null;
}
function owner(
  ownerId: string,
  value: { ownerId: string },
  actor?: Actor,
): void {
  if (value.ownerId !== ownerId || (actor && actor.userId !== ownerId))
    throw new ConflictError("OWNER_MISMATCH", "保存先が一致しません。");
}

export class LibsqlMemoRepository implements MemoRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly ownerId: string,
  ) {}
  list() {
    return rows(
      this.tx,
      `SELECT ${memoColumns} FROM fog_memos WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC`,
      [this.ownerId],
      memoSchema,
    );
  }
  find(id: string) {
    return one(
      this.tx,
      `SELECT ${memoColumns} FROM fog_memos WHERE owner_id=? AND id=? AND deleted_at IS NULL`,
      [this.ownerId, id],
      memoSchema,
    );
  }
  page(input: {
    limit: number;
    keyword: string;
    before?: TimelineKey;
    at?: TimelineKey;
  }) {
    const conditions = [
      "owner_id=?",
      "deleted_at IS NULL",
      "instr(lower(body),lower(?))>0",
    ];
    const args: InValue[] = [this.ownerId, input.keyword];
    const key = input.before ?? input.at;
    if (key) {
      conditions.push(
        `(created_at<? OR (created_at=? AND id${input.before ? "<" : "<="}?))`,
      );
      args.push(key.createdAt, key.createdAt, key.id);
    }
    args.push(input.limit);
    return rows(
      this.tx,
      `SELECT ${memoColumns} FROM fog_memos WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
      args,
      memoSchema,
    );
  }
  nearest(date: string, keyword: string) {
    const start = `${date}T00:00:00+09:00`;
    return one(
      this.tx,
      `SELECT ${memoColumns} FROM fog_memos WHERE owner_id=? AND deleted_at IS NULL AND instr(lower(body),lower(?))>0 ORDER BY CASE WHEN julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)+1 THEN 0 WHEN julianday(created_at)<julianday(?) THEN julianday(?)-julianday(created_at) ELSE julianday(created_at)-(julianday(?)+1) END ASC,created_at DESC,id DESC LIMIT 1`,
      [this.ownerId, keyword, start, start, start, start, start],
      memoSchema,
    );
  }
  async create(memo: Memo, actor: Actor) {
    owner(this.ownerId, memo, actor);
    await this.tx.execute({
      sql: "INSERT INTO fog_memos(id,owner_id,body,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
      args: [
        memo.id,
        this.ownerId,
        memo.body,
        memo.createdAt,
        memo.updatedAt,
        memo.version,
      ],
    });
    await this.revision(memo, actor);
  }
  async update(memo: Memo, expectedVersion: number, actor: Actor) {
    owner(this.ownerId, memo, actor);
    const result = await this.tx.execute({
      sql: "UPDATE fog_memos SET body=?,updated_at=?,version=? WHERE owner_id=? AND id=? AND version=? AND deleted_at IS NULL",
      args: [
        memo.body,
        memo.updatedAt,
        memo.version,
        this.ownerId,
        memo.id,
        expectedVersion,
      ],
    });
    if (result.rowsAffected !== 1) throw conflict();
    await this.revision(memo, actor);
  }
  private async revision(memo: Memo, actor: Actor) {
    await this.tx.execute({
      sql: "INSERT INTO fog_memo_revisions(memo_id,owner_id,version,body,actor_kind,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        memo.id,
        this.ownerId,
        memo.version,
        memo.body,
        ...actorValues(actor),
        memo.updatedAt,
      ],
    });
  }
  async history(id: string) {
    return (
      await rows(
        this.tx,
        `SELECT ${revisionColumns} FROM fog_memo_revisions WHERE owner_id=? AND memo_id=? ORDER BY version DESC`,
        [this.ownerId, id],
        revisionSchema,
      )
    ).map(revisionView);
  }
  sourceDocuments(id: string) {
    return rows(
      this.tx,
      "SELECT d.id,d.title,CASE WHEN d.deleted_at IS NULL THEN 0 ELSE 1 END AS deleted FROM fog_document_sources s JOIN fog_documents d ON d.id=s.document_id AND d.owner_id=s.owner_id WHERE s.owner_id=? AND s.memo_id=? ORDER BY d.created_at DESC,d.id DESC",
      [this.ownerId, id],
      z.object({
        id: z.string(),
        title: z.string(),
        deleted: z.number().transform((value) => value === 1),
      }),
    );
  }
}

export class LibsqlTopicRepository implements TopicRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly ownerId: string,
  ) {}
  list() {
    return rows(
      this.tx,
      `SELECT ${topicColumns} FROM fog_topics WHERE owner_id=? AND deleted_at IS NULL ORDER BY completed ASC,updated_at DESC,id DESC`,
      [this.ownerId],
      topicSchema,
    );
  }
  find(id: string) {
    return one(
      this.tx,
      `SELECT ${topicColumns} FROM fog_topics WHERE owner_id=? AND id=? AND deleted_at IS NULL`,
      [this.ownerId, id],
      topicSchema,
    );
  }
  async create(topic: Topic) {
    owner(this.ownerId, topic);
    await this.tx.execute({
      sql: "INSERT INTO fog_topics(id,owner_id,title,description,completed,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        topic.id,
        this.ownerId,
        topic.title,
        topic.description,
        topic.completed ? 1 : 0,
        topic.createdAt,
        topic.updatedAt,
        topic.version,
      ],
    });
  }
  async update(topic: Topic, expectedVersion: number) {
    owner(this.ownerId, topic);
    const result = await this.tx.execute({
      sql: "UPDATE fog_topics SET title=?,description=?,completed=?,updated_at=?,version=? WHERE owner_id=? AND id=? AND version=? AND deleted_at IS NULL",
      args: [
        topic.title,
        topic.description,
        topic.completed ? 1 : 0,
        topic.updatedAt,
        topic.version,
        this.ownerId,
        topic.id,
        expectedVersion,
      ],
    });
    if (result.rowsAffected !== 1) throw conflict();
  }
}

export class LibsqlDocumentRepository implements DocumentRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly ownerId: string,
  ) {}
  list(topicId: string) {
    return rows(
      this.tx,
      `SELECT ${documentColumns} FROM fog_documents WHERE owner_id=? AND topic_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC`,
      [this.ownerId, topicId],
      documentSchema,
    );
  }
  find(id: string) {
    return one(
      this.tx,
      `SELECT ${documentColumns} FROM fog_documents WHERE owner_id=? AND id=? AND deleted_at IS NULL`,
      [this.ownerId, id],
      documentSchema,
    );
  }
  async create(
    document: Document,
    sourceMemoIds: string[],
    actor: Actor,
    reason: string,
  ) {
    owner(this.ownerId, document, actor);
    await this.tx.execute({
      sql: "INSERT INTO fog_documents(id,owner_id,topic_id,title,body,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        document.id,
        this.ownerId,
        document.topicId,
        document.title,
        document.body,
        document.createdAt,
        document.updatedAt,
        document.version,
      ],
    });
    await this.revision(document, actor, reason);
    for (const memoId of sourceMemoIds)
      await this.tx.execute({
        sql: "INSERT INTO fog_document_sources(document_id,memo_id,owner_id) VALUES(?,?,?)",
        args: [document.id, memoId, this.ownerId],
      });
  }
  async update(
    document: Document,
    expectedVersion: number,
    actor: Actor,
    reason: string,
  ) {
    owner(this.ownerId, document, actor);
    const result = await this.tx.execute({
      sql: "UPDATE fog_documents SET title=?,body=?,updated_at=?,version=? WHERE owner_id=? AND id=? AND version=? AND deleted_at IS NULL",
      args: [
        document.title,
        document.body,
        document.updatedAt,
        document.version,
        this.ownerId,
        document.id,
        expectedVersion,
      ],
    });
    if (result.rowsAffected !== 1) throw conflict();
    await this.revision(document, actor, reason);
  }
  private async revision(document: Document, actor: Actor, reason: string) {
    await this.tx.execute({
      sql: "INSERT INTO fog_document_revisions(document_id,owner_id,version,title,body,reason,actor_kind,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      args: [
        document.id,
        this.ownerId,
        document.version,
        document.title,
        document.body,
        reason,
        ...actorValues(actor),
        document.updatedAt,
      ],
    });
  }
  async history(id: string) {
    const results = await rows(
      this.tx,
      `SELECT ${revisionColumns},title,reason FROM fog_document_revisions WHERE owner_id=? AND document_id=? ORDER BY version DESC`,
      [this.ownerId, id],
      revisionSchema.extend({ title: z.string(), reason: z.string() }),
    );
    return results.map(({ title, reason, ...revision }) => ({
      ...revisionView(revision),
      title,
      reason,
    }));
  }
  sourceMemos(id: string) {
    return rows(
      this.tx,
      "SELECT m.id,m.body,m.created_at AS createdAt,CASE WHEN m.deleted_at IS NULL THEN 0 ELSE 1 END AS deleted FROM fog_document_sources s JOIN fog_memos m ON m.id=s.memo_id AND m.owner_id=s.owner_id WHERE s.owner_id=? AND s.document_id=? ORDER BY m.created_at DESC,m.id DESC",
      [this.ownerId, id],
      z.object({
        id: z.string(),
        body: z.string(),
        createdAt: z.string(),
        deleted: z.number().transform((value) => value === 1),
      }),
    );
  }
  relatedMemos(topicId: string) {
    return rows(
      this.tx,
      `SELECT ${memoColumns} FROM fog_memos WHERE owner_id=? AND deleted_at IS NULL AND id IN (SELECT s.memo_id FROM fog_document_sources s JOIN fog_documents d ON d.id=s.document_id AND d.owner_id=s.owner_id WHERE s.owner_id=? AND d.topic_id=? AND d.deleted_at IS NULL) ORDER BY created_at DESC,id DESC`,
      [this.ownerId, this.ownerId, topicId],
      memoSchema,
    );
  }
}
