"use client";

import type { CredentialView } from "@repo/core/application/identity/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ButtonAnchor } from "@/components/ui/ButtonAnchor";
import { FormError } from "@/components/ui/FormError";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Row } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";
import { RowList } from "@/components/ui/RowList";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { unlinkSsoCredentialFn } from "../actions";
import { ItemMeta, ItemName, ItemNote } from "../SettingsSection";
import { useSsoLinkError } from "../SsoNotice";
import { isCredentialUnlinkedResult } from "../schema";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  google: "Google",
  apple: "Apple",
};

const PROVIDER_ICONS: Readonly<Record<string, IconName>> = {
  google: "google",
  apple: "apple",
};

/** The provider as the screens name it: 「Google」 for `google`. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export const LINK_INTENT = "link";

/**
 * `/auth/sso/:provider/start` with `intent=link` — the only entry that
 * creates something P-03 can unlink. A bare handler of the request Worker,
 * not a route, so the row links to it with `ButtonAnchor`.
 */
export function linkStartHref(provider: string): string {
  return `/auth/sso/${provider}/start?intent=${LINK_INTENT}`;
}

type RowFailure = Readonly<{ credentialId: string; message: string }>;

/**
 * The login methods (P-13 / P-03), owned as a list because unlinking is a
 * membership change: the row leaves optimistically, the server function
 * runs here, and a rejection puts the row back with its reason under it.
 * The email method is named by the address when `email` is given; a
 * uniqueness hold (an email credential nobody can log in with) is not a
 * login method and is not listed. The last login method offers no unlink
 * (spec/pages/index.md P-13). Never shows a verifier or a provider subject:
 * the view has none.
 */
export function CredentialList({
  credentials,
  linkProviders,
  email,
}: Readonly<{
  credentials: readonly CredentialView[];
  /** The providers to offer a link for (P-13: `AppConfig.ssoProviders`; P-03: none). */
  linkProviders: readonly string[];
  /** The account's address, which names the email method's row. */
  email?: string;
}>) {
  const router = useRouter();
  const unlink = useServerFn(unlinkSsoCredentialFn);
  const linkError = useSsoLinkError();
  const [, startTransition] = useTransition();
  const [failure, setFailure] = useState<RowFailure | null>(null);
  const [shown, remove] = useOptimistic<readonly CredentialView[], string>(
    credentials,
    (current, credentialId) =>
      current.filter((c) => c.credentialId !== credentialId),
  );
  const loginMethods = shown.filter((c) => c.usableForLogin).length;

  const onUnlink = (credentialId: string) => {
    setFailure(null);
    startTransition(async () => {
      remove(credentialId);
      try {
        readServerFnResult(
          await unlink({ data: { credentialId } }),
          isCredentialUnlinkedResult,
          "unlinkSsoCredentialFn",
        );
        await router.invalidate();
      } catch (error) {
        setFailure({ credentialId, message: displayError(error) });
      }
    });
  };

  return (
    <div>
      <RowList aria-label="ログイン手段">
        {shown.map((credential) => {
          if (credential.kind === "email") {
            if (!credential.usableForLogin) return null;
            return (
              <li key={credential.credentialId}>
                <Row>
                  <ItemName>{email ?? "メールアドレス"}</ItemName>
                  <ItemMeta>メール・パスワード</ItemMeta>
                </Row>
              </li>
            );
          }
          const name = providerName(credential.label);
          const last = credential.usableForLogin && loginMethods === 1;
          return (
            <li key={credential.credentialId}>
              <Row
                actions={
                  last ? (
                    <ItemNote>解除できません</ItemNote>
                  ) : (
                    <Button
                      variant="danger-text"
                      onClick={() => onUnlink(credential.credentialId)}
                      aria-label={`${name} の連携を解除`}
                    >
                      連携を解除
                    </Button>
                  )
                }
                error={
                  failure?.credentialId === credential.credentialId ? (
                    <RowError message={failure.message} />
                  ) : undefined
                }
              >
                <ItemName>{name}</ItemName>
                {last ? <ItemMeta>最後のログイン手段</ItemMeta> : null}
              </Row>
            </li>
          );
        })}
      </RowList>
      {linkProviders.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm border-t border-neutral-100 py-row">
          <span className="font-base text-sm font-medium leading-tight text-neutral-900">
            連携を追加
          </span>
          <div className="flex flex-wrap items-center gap-sm">
            {linkProviders.map((provider) => {
              const icon = PROVIDER_ICONS[provider];
              return (
                <ButtonAnchor
                  key={provider}
                  variant="outline"
                  href={linkStartHref(provider)}
                >
                  {icon === undefined ? null : <Icon name={icon} size="md" />}
                  {providerName(provider)} で続行
                </ButtonAnchor>
              );
            })}
          </div>
        </div>
      )}
      {linkError !== null && (
        <div className="mt-xs">
          <FormError>{linkError}</FormError>
        </div>
      )}
    </div>
  );
}
