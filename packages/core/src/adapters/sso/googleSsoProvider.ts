import {
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  SsoAssertion,
  SsoIdentityProvider,
} from "@repo/core/application/ports/ssoIdentityProvider";

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleSsoProviderOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  /** `${APP_URL}/auth/sso/google/callback`, registered with the client. */
  redirectUri: string;
  fetch?: typeof fetch;
}>;

/**
 * Google's OpenID Connect authorization-code flow. Only the `google`
 * provider is served; another provider name is a configuration error,
 * and the composition root chooses the adapter per provider. A verified
 * address is required: an unverified one cannot reserve an email
 * credential (`ValidationError("SSO_EMAIL_UNVERIFIED")`).
 */
export function createGoogleSsoProvider(
  options: GoogleSsoProviderOptions,
): SsoIdentityProvider {
  const fetchImpl = options.fetch ?? fetch;
  const requireGoogle = (provider: string) => {
    if (provider !== "google") {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        `No identity provider is configured for "${provider}"`,
      );
    }
  };
  return {
    buildAuthorizationUrl(provider, state) {
      requireGoogle(provider);
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "select_account");
      return url.toString();
    },
    async exchangeCode(provider, code): Promise<SsoAssertion | "cancelled"> {
      requireGoogle(provider);
      const token = await postForm(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: options.redirectUri,
        grant_type: "authorization_code",
      });
      const accessToken = (token as { access_token?: unknown }).access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new SystemError(
          SystemErrorCode.ExternalApiError,
          "The identity provider answered without an access token",
        );
      }
      const info = await getJson(
        fetchImpl,
        GOOGLE_USERINFO_ENDPOINT,
        accessToken,
      );
      const { sub, email, email_verified } = info as {
        sub?: unknown;
        email?: unknown;
        email_verified?: unknown;
      };
      if (
        typeof sub !== "string" ||
        sub.length === 0 ||
        typeof email !== "string"
      ) {
        throw new SystemError(
          SystemErrorCode.ExternalApiError,
          "The identity provider answered without a subject",
        );
      }
      if (email_verified !== true) {
        throw new ValidationError(
          "SSO_EMAIL_UNVERIFIED",
          "The identity provider has not verified this email address",
        );
      }
      return { providerSubject: sub, email };
    },
  };
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    throw new SystemError(
      SystemErrorCode.NetworkError,
      "The identity provider could not be reached",
      cause,
    );
  }
  if (!response.ok) {
    throw new SystemError(
      SystemErrorCode.ExternalApiError,
      `The identity provider answered ${response.status}`,
    );
  }
  return response.json();
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  bearer: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${bearer}` },
    });
  } catch (cause) {
    throw new SystemError(
      SystemErrorCode.NetworkError,
      "The identity provider could not be reached",
      cause,
    );
  }
  if (!response.ok) {
    throw new SystemError(
      SystemErrorCode.ExternalApiError,
      `The identity provider answered ${response.status}`,
    );
  }
  return response.json();
}
