import { buttonClassName } from "@/components/ui/Button/styles";
import { Icon, type IconName } from "@/components/ui/Icon";
import type { SsoErrorCode } from "../schema";

type Provider = Readonly<{ name: string; icon: IconName }>;

/** The providers the mocks draw; a name the list carries but this table lacks is shown as itself, without a glyph. */
const PROVIDERS: Readonly<Record<string, Provider>> = {
  google: { name: "Google", icon: "google" },
  apple: { name: "Apple", icon: "apple" },
};

/** 「Google で続行」 on login, 「Google で登録」 on signup (`login.html` / `signup.html`). */
export function ssoButtonLabel(
  provider: string,
  mode: "login" | "signup",
): string {
  const name = PROVIDERS[provider]?.name ?? provider;
  return `${name} で${mode === "signup" ? "登録" : "続行"}`;
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
 * The SSO half of P-01 / P-02 (`.sso-group` in `login.html`): outline
 * buttons, one per provider, stretched to the sheet's width. They are plain
 * anchors with the outline step's look, because the round trip is a redirect
 * chain the bare handler owns — neither a server function nor a route the
 * router serves. Drawn from `AppConfig.ssoProviders` — only a provider with
 * an adapter is offered — and absent altogether when none is configured.
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
    <nav
      className="mt-lg flex flex-col gap-sm"
      aria-label="外部アカウントで続行"
    >
      {providers.map((provider) => {
        const icon = PROVIDERS[provider]?.icon;
        return (
          <a
            key={provider}
            className={buttonClassName("outline")}
            href={ssoStartHref(provider, mode, redirectTo)}
          >
            {icon === undefined ? null : <Icon name={icon} size="md" />}
            {ssoButtonLabel(provider, mode)}
          </a>
        );
      })}
    </nav>
  );
}
