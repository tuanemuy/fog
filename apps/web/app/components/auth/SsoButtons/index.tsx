import type { SsoErrorCode } from "../schema";

/** Wording per provider name; a name the list carries but this table lacks falls back to the name itself. */
const LABELS: Readonly<Record<string, string>> = {
  google: "Google で続行",
  apple: "Apple で続行",
};

export function ssoButtonLabel(provider: string): string {
  return LABELS[provider] ?? `${provider} で続行`;
}

/** `/auth/sso/:provider/start` with the page it started from and the return path. */
export function ssoStartHref(
  provider: string,
  from: "login" | "signup",
  redirectTo: string | undefined,
): string {
  const params = new URLSearchParams();
  if (from === "signup") params.set("from", "signup");
  if (redirectTo !== undefined) params.set("redirect", redirectTo);
  const query = params.toString();
  return `/auth/sso/${provider}/start${query.length > 0 ? `?${query}` : ""}`;
}

/** The wording of a `?sso_error=` the bare handler redirected with (P-01 / P-02). */
export function renderSsoError(
  code: SsoErrorCode,
  mode: "login" | "signup",
): string {
  switch (code) {
    case "email_registered":
      return mode === "signup"
        ? "このメールアドレスは既に登録されています。パスワードでログインしてください"
        : "このメールアドレスはパスワードで登録されています。パスワードでログインしてください";
    case "already_used":
      return "この外部アカウントは既に別のアカウントに連携されています";
    case "unverified":
      return "外部アカウントのメールアドレスが確認されていません";
    case "failed":
      return "外部アカウントでの認証に失敗しました。もう一度お試しください";
  }
}

/**
 * The SSO half of P-01 / P-02: plain anchors, because the round trip is a
 * redirect chain the bare handler owns, not a server function. Drawn from
 * `AppConfig.ssoProviders` — only a provider with an adapter is offered —
 * and absent altogether when none is configured.
 */
export function SsoButtons({
  mode,
  redirectTo,
  providers,
}: {
  mode: "login" | "signup";
  redirectTo: string | undefined;
  providers: readonly string[];
}) {
  if (providers.length === 0) return null;
  return (
    <nav className="fog-auth-sso" aria-label="外部アカウントで続行">
      {providers.map((provider) => (
        <a
          key={provider}
          className="fog-secondary"
          href={ssoStartHref(provider, mode, redirectTo)}
        >
          {ssoButtonLabel(provider)}
        </a>
      ))}
    </nav>
  );
}
