import type { ServiceArgs } from "../types";

export type ConsumeAuthorizationCodeInput = Readonly<{
  userId: string;
  /** The code's one-time id; recorded in `oauth_consumed_codes` on first use. */
  jti: string;
  /** The code's own expiry: the row need not outlive it. */
  expiresAt: Date;
  connectionId: string;
}>;

export type ConsumeAuthorizationCodeOutput =
  | Readonly<{ ok: true; clientName: string }>
  | Readonly<{ ok: false }>;

/**
 * The token endpoint's one write: the code's `jti` is spent and the
 * connection it names is confirmed active, in one transaction of the
 * user's own Durable Object (`spec/database/index.md`, `oauth_consumed_codes`).
 * `ok: false` for a code already spent and for a connection no longer
 * active alike — the transport answers `invalid_grant` for both.
 */
export async function consumeAuthorizationCode({
  container,
  input,
}: ServiceArgs<ConsumeAuthorizationCodeInput>): Promise<ConsumeAuthorizationCodeOutput> {
  return container.identityGateway.consumeAuthorizationCode(input.userId, {
    jti: input.jti,
    expiresAt: input.expiresAt,
    connectionId: input.connectionId,
  });
}
