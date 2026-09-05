import type { InValue, Transaction } from "@libsql/client";
import {
  NotFoundError,
  UnauthorizedError,
} from "@repo/core/application/errors";
import type {
  AiAuthorizationCode,
  AiAuthorizationRequest,
  AiConnection,
  AiLedgerEntry,
  AiRepository,
} from "@repo/core/application/fog/aiPorts";
import { aiWriteOperations } from "@repo/core/domain/fog/ai";
import { z } from "zod";

const requestSchema = z.object({
  tokenHash: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  state: z.string(),
  codeChallenge: z.string(),
  expiresAt: z.string(),
  ownerId: z.string().nullable(),
  consumed: z.number().transform((value) => value === 1),
});
const codeSchema = z.object({
  codeHash: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  ownerId: z.string(),
  expiresAt: z.string(),
});
const connectionSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  tokenHash: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
const connectionColumns =
  "id,owner_id ownerId,token_hash tokenHash,client_id clientId,client_name clientName,created_at createdAt,last_used_at lastUsedAt,expires_at expiresAt,revoked_at revokedAt";
const ledgerSchema = z.object({
  connectionId: z.string(),
  keyHash: z.string(),
  payloadHash: z.string(),
  operation: z.enum(aiWriteOperations),
  requestId: z.string(),
  resourceKind: z.enum(["memo", "document", "topic"]).nullable(),
  resourceId: z.string().nullable(),
  createdAt: z.string(),
});
async function one<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T | null> {
  const row = (await tx.execute({ sql, args })).rows[0];
  return row ? schema.parse(row) : null;
}
export class LibsqlAiRepository implements AiRepository {
  constructor(private readonly tx: Transaction) {}
  async createRequest(r: AiAuthorizationRequest) {
    await this.tx.execute({
      sql: "INSERT INTO fog_ai_authorization_requests(token_hash,client_id,redirect_uri,state,code_challenge,expires_at,owner_id,consumed) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        r.tokenHash,
        r.clientId,
        r.redirectUri,
        r.state,
        r.codeChallenge,
        r.expiresAt,
        r.ownerId,
        r.consumed ? 1 : 0,
      ],
    });
  }
  findRequest(tokenHash: string) {
    return one(
      this.tx,
      "SELECT token_hash tokenHash,client_id clientId,redirect_uri redirectUri,state,code_challenge codeChallenge,expires_at expiresAt,owner_id ownerId,consumed FROM fog_ai_authorization_requests WHERE token_hash=?",
      [tokenHash],
      requestSchema,
    );
  }
  async bindRequest(tokenHash: string, ownerId: string) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_ai_authorization_requests SET owner_id=? WHERE token_hash=? AND consumed=0 AND (owner_id IS NULL OR owner_id=?)",
      args: [ownerId, tokenHash, ownerId],
    });
    if (result.rowsAffected !== 1)
      throw new UnauthorizedError(
        "INVALID_AI_AUTHORIZATION",
        "認可リクエストが無効です。",
      );
  }
  async consumeRequest(tokenHash: string) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_ai_authorization_requests SET consumed=1 WHERE token_hash=? AND consumed=0",
      args: [tokenHash],
    });
    if (result.rowsAffected !== 1)
      throw new UnauthorizedError(
        "INVALID_AI_AUTHORIZATION",
        "認可リクエストが無効です。",
      );
  }
  async createCode(c: AiAuthorizationCode) {
    await this.tx.execute({
      sql: "INSERT INTO fog_ai_authorization_codes(code_hash,client_id,client_name,redirect_uri,code_challenge,owner_id,expires_at) VALUES(?,?,?,?,?,?,?)",
      args: [
        c.codeHash,
        c.clientId,
        c.clientName,
        c.redirectUri,
        c.codeChallenge,
        c.ownerId,
        c.expiresAt,
      ],
    });
  }
  findCode(codeHash: string) {
    return one(
      this.tx,
      "SELECT code_hash codeHash,client_id clientId,client_name clientName,redirect_uri redirectUri,code_challenge codeChallenge,owner_id ownerId,expires_at expiresAt FROM fog_ai_authorization_codes WHERE code_hash=?",
      [codeHash],
      codeSchema,
    );
  }
  async deleteCode(codeHash: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_ai_authorization_codes WHERE code_hash=?",
      args: [codeHash],
    });
  }
  async createConnection(c: AiConnection) {
    await this.tx.execute({
      sql: "INSERT INTO fog_ai_connections(id,owner_id,token_hash,client_id,client_name,created_at,last_used_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?)",
      args: [
        c.id,
        c.ownerId,
        c.tokenHash,
        c.clientId,
        c.clientName,
        c.createdAt,
        c.lastUsedAt,
        c.expiresAt,
        c.revokedAt,
      ],
    });
  }
  findConnection(tokenHash: string) {
    return one(
      this.tx,
      `SELECT ${connectionColumns} FROM fog_ai_connections WHERE token_hash=?`,
      [tokenHash],
      connectionSchema,
    );
  }
  async listConnections(ownerId: string, now: string) {
    return (
      await this.tx.execute({
        sql: `SELECT ${connectionColumns} FROM fog_ai_connections WHERE owner_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,id DESC`,
        args: [ownerId, now],
      })
    ).rows.map((row) => {
      const {
        ownerId: _,
        tokenHash: __,
        revokedAt: ___,
        ...view
      } = connectionSchema.parse(row);
      return view;
    });
  }
  async revokeConnection(ownerId: string, id: string, now: string) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_ai_connections SET revoked_at=coalesce(revoked_at,?) WHERE owner_id=? AND id=?",
      args: [now, ownerId, id],
    });
    if (result.rowsAffected !== 1)
      throw new NotFoundError(
        "AI_CONNECTION_NOT_FOUND",
        "接続が見つかりません。",
      );
  }
  async touchConnection(id: string, now: string) {
    await this.tx.execute({
      sql: "UPDATE fog_ai_connections SET last_used_at=? WHERE id=? AND revoked_at IS NULL",
      args: [now, id],
    });
  }
  async findLedger(
    connectionId: string,
    keyHash: string,
  ): Promise<AiLedgerEntry | null> {
    const row = await one(
      this.tx,
      "SELECT connection_id connectionId,key_hash keyHash,payload_hash payloadHash,operation,request_id requestId,resource_kind resourceKind,resource_id resourceId,created_at createdAt FROM fog_ai_idempotency WHERE connection_id=? AND key_hash=?",
      [connectionId, keyHash],
      ledgerSchema,
    );
    if (!row) return null;
    const { resourceKind, resourceId, ...entry } = row;
    return {
      ...entry,
      resource:
        resourceKind && resourceId
          ? { kind: resourceKind, id: resourceId }
          : null,
    };
  }
  async saveLedger(e: AiLedgerEntry) {
    await this.tx.execute({
      sql: "INSERT INTO fog_ai_idempotency(connection_id,key_hash,payload_hash,operation,request_id,resource_kind,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        e.connectionId,
        e.keyHash,
        e.payloadHash,
        e.operation,
        e.requestId,
        e.resource?.kind ?? null,
        e.resource?.id ?? null,
        e.createdAt,
      ],
    });
  }
}
