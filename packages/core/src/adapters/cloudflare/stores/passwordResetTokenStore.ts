import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  ConsumedResetToken,
  PasswordResetTokenPort,
} from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import { CredentialId, UserId } from "@repo/core/domain/identity/valueObject";

/** The token-key generation this store derives under; one exists today. */
export const RESET_TOKEN_KEY_GENERATION = 1;

/** 128 bits, base64url: the width of `tokenId`, `change_auth_token` and the secret half of a token. */
const OPAQUE_BYTES = 16;

export type ResetTokenParts = Readonly<{
  generation: number;
  bucketIndex: number;
  secret: string;
}>;

function opaque(): string {
  return randomBytes(OPAQUE_BYTES).toString("base64url");
}

/**
 * The raw token's secret half, derived from `tokenId` under the bucket's
 * reset-token key: never stored, re-derived by the send-materials RPC.
 */
export function deriveResetSecret(key: string, tokenId: string): string {
  return createHmac("sha256", key)
    .update(`reset-token:${tokenId}`)
    .digest("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * `generation.bucketIndex.secret`: the bucket coordinates travel in the
 * token so the request Worker can pick the bucket without a lookup (a
 * bucket names no person); only `secret` is compared.
 */
export function formatResetToken(
  bucket: { generation: number; bucketIndex: number },
  secret: string,
): string {
  return `${bucket.generation}.${bucket.bucketIndex}.${secret}`;
}

export function parseResetToken(token: string): ResetTokenParts | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.([A-Za-z0-9_-]{16,128})$/.exec(token);
  if (match === null) return null;
  return {
    generation: Number(match[1]),
    bucketIndex: Number(match[2]),
    secret: match[3] as string,
  };
}

export type PasswordResetTokenStoreDeps = Readonly<{
  resetTokenKey: string;
  bucket: { generation: number; bucketIndex: number };
  ttlMs: number;
  now: () => number;
}>;

/**
 * `password_reset_tokens` (`spec/database/index.md`). Issue replaces the
 * credential's unused rows; consumption is one conditional UPDATE that
 * also mints the change bearer; the decoy comes from the same generator.
 */
export function createPasswordResetTokenStore(
  sql: SqlStorage,
  deps: PasswordResetTokenStoreDeps,
): PasswordResetTokenPort {
  return {
    issue(credentialId, now) {
      const tokenId = opaque();
      const secret = deriveResetSecret(deps.resetTokenKey, tokenId);
      const at = now.getTime();
      sql.exec(
        "DELETE FROM password_reset_tokens WHERE credential_id = ? AND used_at IS NULL",
        credentialId,
      );
      sql.exec(
        `INSERT INTO password_reset_tokens
           (token_id, token_hash, credential_id, expires_at, used_at, change_auth_token,
            consumed_by_operation_id, token_key_generation, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        tokenId,
        hashSecret(secret),
        credentialId,
        at + deps.ttlMs,
        RESET_TOKEN_KEY_GENERATION,
        at,
      );
      return { token: formatResetToken(deps.bucket, secret), tokenId };
    },

    mintDecoyTokenId() {
      return opaque();
    },

    verifyAndConsume(token, now) {
      const parts = parseResetToken(token);
      if (parts === null) return null;
      const changeAuthToken = opaque();
      const row = sql
        .exec<{ credential_id: string }>(
          `UPDATE password_reset_tokens SET used_at = ?, change_auth_token = ?
           WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
           RETURNING credential_id`,
          now.getTime(),
          changeAuthToken,
          hashSecret(parts.secret),
          now.getTime(),
        )
        .toArray()[0];
      if (row === undefined) return null;
      const mapping = sql
        .exec<{ user_id: string | null }>(
          "SELECT user_id FROM credential_mappings WHERE credential_id = ? AND status = 'active'",
          row.credential_id,
        )
        .toArray()[0];
      if (mapping === undefined || mapping.user_id === null) return null;
      const consumed: ConsumedResetToken = {
        userId: UserId.create(mapping.user_id),
        credentialId: CredentialId.create(row.credential_id),
        changeAuthToken,
      };
      return consumed;
    },
  };
}

/** The raw token the send-materials RPC re-derives for a live, unused `tokenId`. */
export function resetTokenFor(
  sql: SqlStorage,
  deps: Pick<PasswordResetTokenStoreDeps, "resetTokenKey" | "bucket">,
  tokenId: string,
  nowMs: number,
): { token: string; credentialId: string } | null {
  const row = sql
    .exec<{ credential_id: string }>(
      "SELECT credential_id FROM password_reset_tokens WHERE token_id = ? AND used_at IS NULL AND expires_at > ?",
      tokenId,
      nowMs,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    token: formatResetToken(
      deps.bucket,
      deriveResetSecret(deps.resetTokenKey, tokenId),
    ),
    credentialId: row.credential_id,
  };
}
