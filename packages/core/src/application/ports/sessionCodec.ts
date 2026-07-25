/**
 * Issues and verifies opaque session tokens.
 *
 * **Presentation-layer port. No usecase may reference it.** Session
 * creation, destruction and cookie handling are presentation concerns
 * (spec/domains/identity.md「スコープに関する注意」, spec/usecases/identity.md
 * 共通事項): the identity domain has no session state and no logout event.
 * A usecase that reaches for this port is a sign the responsibility split
 * has drifted — put the logic in `apps/web/app/presentation/` instead.
 *
 * The port knows nothing about cookies: it maps a `userId` to a token
 * string and back. Whether that token is a signed stateless blob or a
 * lookup key into a session table is entirely the adapter's business, so
 * the two are interchangeable without touching callers (.issue/1/adr.md ADR-002).
 *
 * `verify` reports every rejection — tampered signature, expired token,
 * unparseable payload — as `null` rather than throwing. "This token is no
 * longer good" is an expected outcome of an ordinary request, not a fault.
 */
export interface SessionCodec {
  issue(userId: string, now: Date): Promise<string>;
  verify(token: string, now: Date): Promise<{ userId: string } | null>;
}
