import type {
  SsoAssertion,
  SsoIdentityProvider,
} from "@repo/core/application/ports/ssoIdentityProvider";
import { fromBase64Url, toBase64Url } from "../webcrypto/encoding";

export const SSO_DEV_STUB_ENABLED = "true";

/**
 * The development identity provider (design D-07): the authorization URL
 * is the app's own `/__dev/sso/:provider/authorize` page, which asks for a
 * subject and an email and bounces back with a code that simply carries
 * them. Enabled by `SSO_DEV_STUB="true"` in `.dev.vars` only.
 */
export function createDevStubSsoProvider(appUrl: string): SsoIdentityProvider {
  return {
    buildAuthorizationUrl(provider, state) {
      const url = new URL(`/__dev/sso/${provider}/authorize`, appUrl);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode(_provider, code) {
      const assertion = decodeDevCode(code);
      return assertion ?? "cancelled";
    },
  };
}

/** The stub's "code": the assertion itself, base64url JSON. Development only. */
export function encodeDevCode(assertion: SsoAssertion): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(assertion)));
}

export function decodeDevCode(code: string): SsoAssertion | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(fromBase64Url(code)),
    ) as Partial<SsoAssertion>;
    if (
      typeof parsed.providerSubject === "string" &&
      parsed.providerSubject.trim().length > 0 &&
      typeof parsed.email === "string"
    ) {
      return { providerSubject: parsed.providerSubject, email: parsed.email };
    }
  } catch {
    // fall through
  }
  return null;
}
