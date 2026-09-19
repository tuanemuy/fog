"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { SsoErrorCode } from "@/components/auth/schema";
import { useToast } from "@/components/ui/Toast";

export const SSO_LINKED_MESSAGE = "外部アカウントを連携しました";

/** The wording of a `?sso_error=` the link callback redirected to P-13 with. */
export function ssoLinkErrorMessage(ssoError: SsoErrorCode): string {
  switch (ssoError) {
    case "already_used":
      return "この外部アカウントは既に使われています";
    case "email_registered":
    case "unverified":
    case "failed":
      return "外部アカウントの連携に失敗しました。もう一度お試しください";
  }
}

const SsoLinkError = createContext<string | null>(null);

/**
 * The outcome of the SSO link the callback redirected to P-13 with. A link
 * that went through is a success, so it is a toast; one that did not belongs
 * to the link entry it was started from, so it is handed down to
 * `CredentialList`, which draws it under that entry (`useSsoLinkError`). The
 * list is inside the streamed fragment, which never sees the URL — hence the
 * context rather than a prop.
 */
export function SsoNotice({
  sso,
  ssoError,
  children,
}: Readonly<{
  sso: "linked" | undefined;
  ssoError: SsoErrorCode | undefined;
  children: ReactNode;
}>) {
  const toast = useToast();
  useEffect(() => {
    if (sso === "linked") toast(SSO_LINKED_MESSAGE);
  }, [sso, toast]);
  return (
    <SsoLinkError.Provider
      value={ssoError === undefined ? null : ssoLinkErrorMessage(ssoError)}
    >
      {children}
    </SsoLinkError.Provider>
  );
}

/** The failed SSO link to show under the link entry; `null` outside P-13. */
export function useSsoLinkError(): string | null {
  return useContext(SsoLinkError);
}
