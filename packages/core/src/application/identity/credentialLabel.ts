import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";

/** `provider U+0000 subject` → the provider; an email canonical has no such part. */
export function ssoProviderOf(canonical: string): string {
  return canonical.split("\u0000")[0] ?? "";
}

/**
 * The non-PII display name `credential_locators.label` carries
 * (`spec/database/index.md`): the provider for an SSO credential, the
 * empty string for an email one. Decided on the Identity Directory side,
 * where the canonical is readable, and carried to the User Data DO as an
 * argument — the reverse index never judges it itself. Both the
 * registration saga and the mapping-key transfer use this one rule.
 */
export function credentialLabelOf(
  kind: CredentialKind,
  canonical: string,
): string {
  return kind === "sso" ? ssoProviderOf(canonical) : "";
}

/** `usable_for_login`: an SSO subject always, an email only with a verifier behind it. */
export function usableForLoginOf(
  kind: CredentialKind,
  passwordVerifier: string | null,
): boolean {
  return kind === "sso" || passwordVerifier !== null;
}
