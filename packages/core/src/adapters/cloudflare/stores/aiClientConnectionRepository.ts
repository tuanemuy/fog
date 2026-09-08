import type { Logger } from "@repo/core/application/ports/logger";
import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { AiClientConnection } from "@repo/core/domain/identity/entity";
import type { AiClientConnectionRepository } from "@repo/core/domain/identity/ports/aiClientConnectionRepository";
import {
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { updateMatchedRow } from "../rowRunner";
import { occConflict } from "./occ";

/** The one token scope a connection can hold (`TokenScope.ai()`). */
export const AI_CONNECTION_SCOPE = "ai";

type Row = Readonly<{
  id: string;
  client_name: string;
  status: "active" | "revoked";
  connected_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at_reset_version: number;
  version: number;
  created_at: number;
  updated_at: number;
}>;

const COLUMNS =
  "id, client_name, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at";

function rehydrate(row: Row, userId: UserId): AiClientConnection {
  const base = {
    id: AiClientConnectionId.create(row.id),
    userId,
    clientName: ClientName.create(row.client_name),
    connectedAt: new Date(row.connected_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
    createdAtResetVersion: row.created_at_reset_version,
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return row.status === "revoked"
    ? { ...base, status: "revoked", revokedAt: new Date(row.revoked_at ?? 0) }
    : { ...base, status: "active" };
}

function versioned<T extends AiClientConnection>(
  entity: T,
  row: Row,
): Versioned<T> {
  return { entity, expectedVersion: row.version as ExpectedVersion<T> };
}

/** `ai_client_connections` (`spec/database/index.md`). */
export function createAiClientConnectionRepository(
  sql: SqlStorage,
  selfUserId: string,
  logger: Logger,
): AiClientConnectionRepository {
  const userId = UserId.create(selfUserId);
  return {
    insert(connection) {
      sql.exec(
        `INSERT INTO ai_client_connections (${COLUMNS}, scope)
         VALUES (?, ?, 'active', ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        connection.id,
        connection.clientName,
        connection.connectedAt.getTime(),
        connection.createdAtResetVersion,
        connection.version,
        connection.createdAt.getTime(),
        connection.updatedAt.getTime(),
        AI_CONNECTION_SCOPE,
      );
    },

    save(connection, expectedVersion) {
      const matched = updateMatchedRow(
        sql,
        `UPDATE ai_client_connections
           SET status = ?, revoked_at = ?, last_used_at = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        connection.status,
        connection.status === "revoked" ? connection.revokedAt.getTime() : null,
        connection.lastUsedAt === null ? null : connection.lastUsedAt.getTime(),
        connection.version,
        connection.updatedAt.getTime(),
        connection.id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
    },

    findById(id) {
      const row = sql
        .exec<Row>(
          `SELECT ${COLUMNS} FROM ai_client_connections WHERE id = ?`,
          id,
        )
        .toArray()[0];
      return row ? versioned(rehydrate(row, userId), row) : null;
    },

    listByUserId() {
      return sql
        .exec<Row>(
          `SELECT ${COLUMNS} FROM ai_client_connections ORDER BY connected_at DESC, id DESC`,
        )
        .toArray()
        .map((row) => rehydrate(row, userId));
    },

    findActiveById(id) {
      const row = sql
        .exec<Row>(
          `SELECT ${COLUMNS} FROM ai_client_connections WHERE id = ? AND status = 'active'`,
          id,
        )
        .toArray()[0];
      if (!row) return null;
      const entity = rehydrate(row, userId);
      return entity.status === "active" ? versioned(entity, row) : null;
    },

    recordUsage(id, lastUsedAt) {
      try {
        sql.exec(
          `UPDATE ai_client_connections
             SET last_used_at = ?, updated_at = ?
           WHERE id = ? AND status = 'active' AND (last_used_at IS NULL OR last_used_at < ?)`,
          lastUsedAt.getTime(),
          lastUsedAt.getTime(),
          id,
          lastUsedAt.getTime(),
        );
      } catch (error) {
        // Best effort by contract: the call this usage belongs to goes on.
        logger.warn("recordUsage failed", {
          connectionId: id,
          cause: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  };
}
