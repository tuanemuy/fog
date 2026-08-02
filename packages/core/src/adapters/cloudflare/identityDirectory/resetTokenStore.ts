import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  ConsumedResetToken,
  PasswordResetTokenPort,
} from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { one, run, type Sql } from "../sql/exec";

/** Hours, not days: a reset link is a bearer credential. */
const RESET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const TOKEN_BYTES = 16;

function randomHex(byteLength: number): string {
  // Called per issue / per consume, always inside a handler — never at module
  // scope, where workerd refuses to produce randomness at all.
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A stored token's lookup key.
 *
 * FNV-1a rather than SHA-256 because the port is synchronous and WebCrypto's
 * digest is not. That is acceptable here only because the input is 128 bits of
 * cryptographic randomness with no structure to guess: the hash is a lookup
 * key, and pre-image resistance is supplied by the token's own entropy rather
 * than by the function. Do not reuse this for anything derived from user input.
 */
function tokenHash(token: string): string {
  let hash = 0x811c9dc5;
  let secondary = 0x01000193;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    secondary ^= token.charCodeAt(token.length - 1 - i);
    secondary = Math.imul(secondary, 0x85ebca6b) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${secondary.toString(16).padStart(8, "0")}`;
}

/**
 * `password_reset_tokens`.
 *
 * The raw token never reaches the table — only a hash of it — so a dump of the
 * database yields no usable link.
 *
 * Issuing deletes every unused token for the same credential **in the same
 * transaction**. Without that, an older link keeps working after the user has
 * asked for a new one, which is the whole reason the port says issuing is per
 * credential rather than per request.
 */
export function createResetTokenStore(
  sql: Sql,
  tokenKeyGeneration: number,
): PasswordResetTokenPort {
  return {
    issue(credentialId: CredentialId, now: Date): string {
      const tokenId = randomHex(TOKEN_BYTES);
      const timestamp = now.getTime();

      run(
        sql,
        "DELETE FROM password_reset_tokens WHERE credential_id = ? AND used_at IS NULL",
        credentialId,
      );
      run(
        sql,
        `INSERT INTO password_reset_tokens (
           token_id, token_hash, credential_id, expires_at, used_at,
           change_auth_token, consumed_by_operation_id, token_key_generation,
           created_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        tokenId,
        tokenHash(tokenId),
        credentialId,
        timestamp + RESET_TOKEN_TTL_MS,
        tokenKeyGeneration,
        timestamp,
      );
      return tokenId;
    },

    verifyAndConsume(
      token: string,
      now: Date,
      operationId: string,
    ): ConsumedResetToken | null {
      const changeAuthToken = randomHex(TOKEN_BYTES);
      // One conditional UPDATE, so two concurrent consumptions converge on one
      // winner; zero matched rows means invalid / expired / already used, which
      // are all the same answer to the caller.
      const consumed = one<{ credential_id: string }>(
        sql,
        `UPDATE password_reset_tokens
            SET used_at = ?, change_auth_token = ?, consumed_by_operation_id = ?
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING credential_id`,
        now.getTime(),
        changeAuthToken,
        operationId,
        tokenHash(token),
        now.getTime(),
      );
      if (consumed === null) return null;

      const mapping = one<{
        user_id: string | null;
        credential_version: number;
      }>(
        sql,
        "SELECT user_id, credential_version FROM credential_mappings WHERE credential_id = ?",
        consumed.credential_id,
      );
      if (mapping === null || mapping.user_id === null) {
        // A token outliving its mapping is a drift the reset flow cannot repair
        // on its own; failing loudly beats resolving to a null user.
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "A reset token was consumed for a credential with no active mapping",
        );
      }
      return {
        userId: mapping.user_id,
        credentialId: consumed.credential_id as CredentialId,
        credentialVersion: mapping.credential_version,
        changeAuthToken,
      };
    },
  };
}
