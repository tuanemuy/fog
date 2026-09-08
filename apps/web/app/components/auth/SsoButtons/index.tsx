import type { SsoErrorCode } from "../schema";

const PROVIDERS = [
  { name: "google", label: "Google で続行" },
  { name: "apple", label: "Apple で続行" },
] as const;

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
    case "cancelled":
      return "外部アカウントでの認証が中断されました";
    case "unverified":
      return "外部アカウントのメールアドレスが確認されていません";
    case "failed":
      return "外部アカウントでの認証に失敗しました。もう一度お試しください";
  }
}

/**
 * The SSO half of P-01 / P-02: plain anchors, because the round trip is a
 * redirect chain the bare handler owns, not a server function.
 */
export function SsoButtons({
  mode,
  redirectTo,
}: {
  mode: "login" | "signup";
  redirectTo: string | undefined;
}) {
  return (
    <nav className="fog-auth-sso" aria-label="外部アカウントで続行">
      {PROVIDERS.map((provider) => (
        <a
          key={provider.name}
          className="fog-secondary"
          href={ssoStartHref(provider.name, mode, redirectTo)}
        >
          {provider.label}
        </a>
      ))}
    </nav>
  );
}
