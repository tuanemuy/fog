import { createHmac } from "node:crypto";
import type { SendMailMaterials } from "@repo/core/application/delivery/types";
import { timingSafeEqual } from "../../webcrypto/encoding";
import { openCanonical } from "../crypto/canonicalCipher";
import type { EncryptionKeyring } from "../crypto/keyring";
import { resetTokenFor } from "./passwordResetTokenStore";

/** 128 bits of base64url — the floor a presented `owner_token` must reach before the row is even read. */
export const OWNER_TOKEN_MIN_LENGTH = 22;

export type SendMailMaterialsDeps = Readonly<{
  resetTokenKey: string;
  providerIdempotencyKey: string;
  bucket: { generation: number; bucketIndex: number };
  encryptionKeyring: EncryptionKeyring;
  nowMs: number;
}>;

type OutboxRow = Readonly<{
  status: string;
  owner_token: string | null;
  payload: string;
}>;

type MappingRow = Readonly<{
  kind: string;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
}>;

const NOTHING: SendMailMaterials = { kind: "nothing-to-send" };

/** `providerIdempotencyKey` = HMAC(PROVIDER_IDEMPOTENCY_KEY, event.id): deterministic, and the key never leaves the bucket. */
export function providerIdempotencyKeyOf(key: string, eventId: string): string {
  return createHmac("sha256", key)
    .update(`provider-idempotency:${eventId}`)
    .digest("hex");
}

/**
 * The send-materials RPC (`spec/async/index.md`). `send` only when the
 * row exists, is not quarantined and the presented `owner_token` equals
 * the stored one (never `NULL`, never short, compared in constant time)
 * — and then only while the token it names is unused and live and its
 * credential still holds a verifier. Everything else is the same empty
 * `nothing-to-send`; the guard never says which condition failed.
 */
export async function readResetMailMaterials(
  sql: SqlStorage,
  input: { eventId: string; ownerToken: string | null | undefined },
  deps: SendMailMaterialsDeps,
): Promise<SendMailMaterials> {
  const presented = input.ownerToken ?? "";
  if (presented.length < OWNER_TOKEN_MIN_LENGTH) return NOTHING;
  const row = sql
    .exec<OutboxRow>(
      "SELECT status, owner_token, payload FROM outbox_events WHERE id = ?",
      input.eventId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.status === "quarantined" ||
    row.owner_token === null
  ) {
    return NOTHING;
  }
  const encoder = new TextEncoder();
  if (
    !timingSafeEqual(encoder.encode(row.owner_token), encoder.encode(presented))
  ) {
    return NOTHING;
  }
  let tokenId: unknown;
  try {
    tokenId = (JSON.parse(row.payload) as { tokenId?: unknown }).tokenId;
  } catch {
    return NOTHING;
  }
  if (typeof tokenId !== "string") return NOTHING;
  const live = resetTokenFor(sql, deps, tokenId, deps.nowMs);
  if (live === null) return NOTHING;
  const mapping = sql
    .exec<MappingRow>(
      `SELECT kind, encrypted_canonical, encryption_generation, encryption_nonce
       FROM credential_mappings
       WHERE credential_id = ? AND status = 'active' AND password_verifier IS NOT NULL`,
      live.credentialId,
    )
    .toArray()[0];
  if (mapping === undefined || mapping.kind !== "email") return NOTHING;
  const to = await openCanonical(
    deps.encryptionKeyring,
    { kind: "email", credentialId: live.credentialId },
    {
      ciphertext: mapping.encrypted_canonical,
      encryptionGeneration: mapping.encryption_generation,
      nonce: mapping.encryption_nonce,
    },
  );
  if (to === null) return NOTHING;
  return {
    kind: "send",
    to,
    resetToken: live.token,
    providerIdempotencyKey: providerIdempotencyKeyOf(
      deps.providerIdempotencyKey,
      input.eventId,
    ),
  };
}
