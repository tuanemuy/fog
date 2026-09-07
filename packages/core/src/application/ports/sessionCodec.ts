/**
 * Issues and verifies opaque session tokens.
 *
 * **Presentation-layer port. No usecase may reference it.** Session
 * creation, destruction and cookie handling are presentation concerns
 * (the 「スコープに関する注意」 section of `spec/domains/identity.md` and the
 * 共通事項 section of `spec/usecases/identity.md`): the identity domain has
 * no session state and no logout event.
 * A usecase that reaches for this port is a sign the responsibility split
 * has drifted — put the logic in `apps/web/app/presentation/` instead.
 *
 * The port knows nothing about cookies: it maps a `userId` to a token
 * string and back. Whether that token is a signed stateless blob or a
 * lookup key into a session table is entirely the adapter's business, so
 * the two are interchangeable without touching callers.
 *
 * `verify` reports every rejection — tampered signature, expired token,
 * unparseable payload — as `null` rather than throwing. "This token is no
 * longer good" is an expected outcome of an ordinary request, not a fault.
 *
 * **The token carries the session generation it was issued under**, and
 * `verify` hands it back. The codec does not judge it: expiry against the
 * account's current generation is the caller's comparison, because the
 * authority on that number is the user's own Durable Object and the codec
 * reads no storage. Without the field there would be nothing to compare
 * against, which is why it is part of the signed payload rather than of
 * the caller's bookkeeping.
 */
export interface SessionCodec {
  issue(userId: string, sessionEpoch: number, now: Date): Promise<string>;
  verify(
    token: string,
    now: Date,
  ): Promise<{ userId: string; sessionEpoch: number } | null>;
}
