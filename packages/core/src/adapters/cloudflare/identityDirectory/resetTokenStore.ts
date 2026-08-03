import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  ConsumedResetToken,
  PasswordResetTokenPort,
  ResetTokenIssueMaterial,
} from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { one, run, type Sql } from "../sql/exec";

/** Hours, not days: a reset link is a bearer credential. */
const RESET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const CHANGE_AUTH_TOKEN_BYTES = 16;

function randomHex(byteLength: number): string {
  // Called per consume, always inside a handler — never at module scope, where
  // workerd refuses to produce randomness at all.
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `password_reset_tokens`.
 *
 * **This module derives nothing.** `token_id`, `token_hash` and the key
 * generation all arrive as arguments, because the derivation is WebCrypto and a
 * `run()` callback is type-rejected from being asynchronous — so it happens one
 * level out, in the Durable Object's RPC entry point
 * (`identityDirectory/resetTokenCrypto.ts`, ADR-042). The same reason
 * `reserveCredential` takes a sealed canonical rather than a plaintext one.
 *
 * What the row therefore holds is `token_id` — an identifier, never accepted as
 * proof — and `SHA-256` of the secret half of the mailed link. Producing that
 * secret from the row needs the reset-token keyring, which is not in the
 * database; producing it from the hash needs a SHA-256 pre-image. Submitting
 * `token_id` matches nothing.
 *
 * Issuing deletes every unused token for the same credential **in the same
 * transaction**. Without that, an older link keeps working after the user has
 * asked for a new one, which is the whole reason the port says issuing is per
 * credential rather than per request.
 */
export function createResetTokenStore(sql: Sql): PasswordResetTokenPort {
  return {
    issue(
      credentialId: CredentialId,
      material: ResetTokenIssueMaterial,
      now: Date,
    ): void {
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
        material.tokenId,
        material.tokenHash,
        credentialId,
        timestamp + RESET_TOKEN_TTL_MS,
        material.tokenKeyGeneration,
        timestamp,
      );
    },

    verifyAndConsume(
      tokenHash: string,
      now: Date,
      operationId: string,
    ): ConsumedResetToken | null {
      const changeAuthToken = randomHex(CHANGE_AUTH_TOKEN_BYTES);
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
        tokenHash,
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
