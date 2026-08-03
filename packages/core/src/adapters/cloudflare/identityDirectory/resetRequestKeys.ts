import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { RESET_REQUEST_WINDOW_MS } from "@repo/core/lib/jobBudgets";

/**
 * The two keys a reset request's `send-mail` row carries, and the one-way step
 * between them.
 *
 * ```
 * (kind, hmac, now)  --window--------->  operationKey        (the job row's identity)
 * operationKey       --SHA-256--------->  providerIdempotencyKey  (leaves the trust boundary)
 * ```
 *
 * ## Why the second is a hash and not the first string itself
 *
 * `operationKey` embeds the canonical address's **full-length HMAC**, which is
 * what a `credential_mappings` row is keyed by and what
 * `DIRECTORY_ROUTING_SECRET` exists to keep unguessable from a candidate
 * address. `providerIdempotencyKey` is handed to the mail provider as an
 * `Idempotency-Key` header, i.e. it crosses the boundary the routing secret
 * defines. Sending the key itself would let an (address, HMAC) table accumulate
 * outside — the same argument ADR-045 made for the runner's logs, one hop
 * further out (ADR-092).
 *
 * SHA-256 keeps every property the header needs: it is a deterministic function
 * of the `operationKey`, so a redelivery of one row presents the same key and a
 * new window presents a new one.
 */

/**
 * `send-mail:{kind}:{hmac}:{window}`.
 *
 * The window is `floor(now / RESET_REQUEST_WINDOW_MS)`, the same number the
 * issue throttle decides eligibility on — sharing it is what makes an eligible
 * request always land on a key no row exists for yet.
 */
export function sendMailOperationKey(
  kind: CredentialMappingKind,
  hmac: string,
  now: number,
): string {
  return `send-mail:${kind}:${hmac}:${Math.floor(now / RESET_REQUEST_WINDOW_MS)}`;
}

/**
 * Asynchronous, so it runs in the Durable Object's RPC entry point and arrives
 * inside the transaction as a plain string — the same shape the sealed canonical
 * and the reset-token material use, and for the same reason (a `run()` callback
 * is type-rejected from being asynchronous).
 */
export async function deriveProviderIdempotencyKey(
  operationKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(operationKey),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
