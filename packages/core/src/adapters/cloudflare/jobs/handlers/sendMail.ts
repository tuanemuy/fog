import type { Keyring } from "@repo/core/application/di/secrets";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { holdsPasswordVerifier } from "@repo/core/domain/identity/credentialMappingRules";
import type { Email } from "@repo/core/domain/identity/valueObject";
import { decryptCanonical } from "../../identityDirectory/canonicalCipher";
import {
  deriveResetSecret,
  formatResetToken,
} from "../../identityDirectory/resetTokenCrypto";
import { readSelfLocator } from "../../schema/gate";
import { one, type Sql } from "../../sql/exec";
import type { IdentityDirectoryJobContext, JobHandler } from "../registry";
import type { JobRow } from "../table";

/**
 * Password-reset mail — the **only** job of the twelve that reaches outside the
 * Durable Object, and the reason external I/O has to ride a durable job at all
 * (a `transactionSync` callback is fully synchronous and cannot `fetch`).
 *
 * ## The payload carries the request, never the answer
 *
 * All the row holds is the `(kind, hmac)` the caller asked about — the same
 * pair its `operation_key` already carries, alongside the request window
 * (ADR-043). Everything else is resolved from this
 * bucket's tables at send time. Two things force that shape. A job row is
 * readable by anyone who can read the table and survives in the
 * point-in-time-recovery log for thirty days after pruning, so a token on it
 * would be a secret at rest; and a payload that varied with the outcome would
 * make a burst against a registered address collide on `payload_digest` while a
 * burst against an unregistered one did not — a timing-free enumeration oracle
 * (`.thread/37/adr.md` ADR-029).
 *
 * The link's secret half is `HMAC(IDENTITY_RESET_TOKEN_KEY[generation],
 * tokenId)`, derived moments before the send from
 * `identityDirectory/resetTokenCrypto.ts` — the same module the issuing entry
 * point hashed the row's `token_hash` with, which is what makes issue, delivery
 * and consumption compose (ADR-042). Neither a database dump nor the key alone
 * reproduces it: the dump lacks the key, and the key lacks 128 bits of
 * `tokenId`.
 *
 * ## Every request writes a row; only some rows have a recipient
 *
 * "Send nothing" is expressed by a row with no recipient, never by skipping the
 * enqueue: writing a row is a measurable amount of work, so making it
 * conditional would answer "is this address registered?" through a timing
 * channel. Four situations all reach this handler identically and all leave
 * `done` — registered, unregistered, SSO-only (an address reservation holding
 * no `password_verifier`) and throttled. The first sends; the rest do not.
 *
 * ## Idempotency
 *
 * Execution is at-least-once, so the provider is handed the job's
 * `provider_idempotency_key`, which is derived from the `operation_key` and is
 * therefore stable across every redelivery of the same row. Deriving it from
 * the message instead would give each retry a new key.
 */

type TokenRow = {
  token_id: string;
  token_key_generation: number;
};

type MappingRow = {
  kind: string;
  credential_id: string;
  password_verifier: string | null;
  encrypted_canonical: string | null;
  encryption_generation: number | null;
  encryption_nonce: string | null;
};

function readTarget(row: JobRow): { kind: string; hmac: string } | null {
  const payload = JSON.parse(row.payload) as {
    kind?: unknown;
    hmac?: unknown;
  } | null;
  if (typeof payload?.kind !== "string" || typeof payload.hmac !== "string") {
    return null;
  }
  return { kind: payload.kind, hmac: payload.hmac };
}

function requireKeyring(keyring: Keyring | null, name: string): Keyring {
  if (keyring === null) {
    // Loud, not silent: a deployment missing this binding can issue tokens and
    // never deliver them, and a `done` row would record that as success.
    throw new SystemError(
      SystemErrorCode.CryptoError,
      `${name} is not configured on the state Worker`,
    );
  }
  return keyring;
}

/**
 * `{generation}.{bucketIndex}.{random}`, where the two numbers are this
 * bucket's own routing coordinates, read from `_meta.self_locator`. They let
 * the consumption endpoint route the link back to the bucket that issued it
 * **without** the routing secret, which is a request-Worker secret and is not
 * distributed here.
 *
 * The generation in the token is the *routing* generation. The reset-token key
 * generation is a separate number system and stays on the token row: verifying
 * is a hash comparison and needs no derivation key.
 */
function routingCoordinates(sql: Sql): { generation: number; bucket: number } {
  const locator = readSelfLocator(sql) ?? "";
  const match = /^dir:g(\d+):b(\d+)$/.exec(locator);
  if (match === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "This bucket has no usable self locator",
    );
  }
  return { generation: Number(match[1]), bucket: Number(match[2]) };
}

async function deriveResetToken(
  keyring: Keyring,
  generation: number,
  tokenId: string,
  routing: { generation: number; bucket: number },
): Promise<string> {
  return formatResetToken(
    routing,
    await deriveResetSecret(keyring, generation, tokenId),
  );
}

export const sendMail: JobHandler<IdentityDirectoryJobContext> = async (
  context,
  row,
) => {
  const { sql, now, logger, mailSender, secrets } = context;

  const target = readTarget(row);
  if (target === null) {
    return { kind: "terminal", reason: "SEND_MAIL_PAYLOAD_INVALID" };
  }

  const mapping = one<MappingRow>(
    sql,
    `SELECT kind, credential_id, password_verifier, encrypted_canonical,
            encryption_generation, encryption_nonce
       FROM credential_mappings WHERE kind = ? AND hmac = ?`,
    target.kind,
    target.hmac,
  );
  // No mapping, or one holding no verification material. The second is an
  // SSO-only account's address reservation: it *does* have a stored original,
  // so "is there an address" would answer yes and send a link that promotes a
  // reservation into a way in. The test is the verifier, not the address — and
  // it is the domain's, so that the lookup entry, the reset request and this
  // send cannot drift apart (ADR-072).
  if (
    mapping === null ||
    !holdsPasswordVerifier({ passwordVerifier: mapping.password_verifier })
  ) {
    return { kind: "done" };
  }

  // The live token, if the request that queued this row was allowed to issue
  // one. A throttled request issues none, and `issue` deletes the credential's
  // earlier unused rows, so there is at most one to find.
  const token = one<TokenRow>(
    sql,
    `SELECT token_id, token_key_generation
       FROM password_reset_tokens
      WHERE credential_id = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1`,
    mapping.credential_id,
    now,
  );
  if (token === null) return { kind: "done" };

  if (
    mapping.encrypted_canonical === null ||
    mapping.encryption_generation === null ||
    mapping.encryption_nonce === null
  ) {
    // No stored original means no address to send to. Named without the id it
    // could not resolve: this is an unauthenticated flow and `userId` is not a
    // value that may appear in its logs.
    logger.warn("password reset mail has no recoverable recipient");
    return { kind: "done" };
  }

  const address = await decryptCanonical(
    requireKeyring(
      secrets?.mailEncryptionKeyring ?? null,
      "IDENTITY_MAIL_ENCRYPTION_KEY",
    ),
    {
      ciphertext: mapping.encrypted_canonical,
      nonce: mapping.encryption_nonce,
    },
    {
      kind: mapping.kind,
      credentialId: mapping.credential_id,
      generation: mapping.encryption_generation,
    },
  );

  const resetToken = await deriveResetToken(
    requireKeyring(
      secrets?.resetTokenKeyring ?? null,
      "IDENTITY_RESET_TOKEN_KEY",
    ),
    token.token_key_generation,
    token.token_id,
    routingCoordinates(sql),
  );

  await mailSender.sendPasswordResetMail(
    address as Email,
    resetToken,
    row.provider_idempotency_key ?? row.operation_key,
  );
  return { kind: "done" };
};
