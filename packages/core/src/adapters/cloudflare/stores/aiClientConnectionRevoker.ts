import type { AiClientConnectionRevoker } from "@repo/core/application/identity/aiClientConnectionRevoker";

export function createAiClientConnectionRevoker(
  sql: SqlStorage,
  now: () => number,
): AiClientConnectionRevoker {
  const revoke = (predicate: string, ...binds: SqlStorageValue[]): number => {
    const at = now();
    return sql
      .exec<{ n: number }>(
        `UPDATE ai_client_connections
           SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
         WHERE status = 'active' ${predicate}
         RETURNING 1 AS n`,
        at,
        at,
        ...binds,
      )
      .toArray().length;
  };
  return {
    revokeCreatedAtResetVersion(resetVersion) {
      return revoke("AND created_at_reset_version = ?", resetVersion);
    },
    revokeAll() {
      return revoke("");
    },
  };
}
