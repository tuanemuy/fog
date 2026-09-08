import type { SsoProvider } from "@repo/core/domain/identity/valueObject";

export type SsoAssertion = Readonly<{
  providerSubject: string;
  email: string;
}>;

/**
 * The identity-provider round trip (design D-07). Presentation-only, like
 * `SessionCodec`: a usecase receives the verified assertion and never sees
 * the redirect, the code or the provider. `exchangeCode` answers
 * `"cancelled"` for a provider-side cancel, which the screen treats as an
 * interruption rather than an error (P-01).
 */
export interface SsoIdentityProvider {
  buildAuthorizationUrl(provider: SsoProvider, state: string): string;
  exchangeCode(
    provider: SsoProvider,
    code: string,
  ): Promise<SsoAssertion | "cancelled">;
}
