import { BusinessRuleError } from "../error";
import type { Email, UserId } from "./valueObject";

export type LoginCredential = Readonly<{
  id: string;
  kind: "password" | "sso";
}>;

export type AccountIdentity = Readonly<{
  id: UserId;
  primaryEmail: Email;
  credentials: readonly LoginCredential[];
}>;

function create(input: AccountIdentity): AccountIdentity {
  if (input.credentials.length === 0) {
    throw new BusinessRuleError(
      "IDENTITY_LAST_CREDENTIAL_REQUIRED",
      "An active account must have a login credential",
    );
  }
  if (
    new Set(input.credentials.map((credential) => credential.id)).size !==
    input.credentials.length
  ) {
    throw new BusinessRuleError(
      "IDENTITY_CREDENTIAL_DUPLICATED",
      "Logical credential identifiers must be unique",
    );
  }
  return input;
}

function canUnlink(account: AccountIdentity, credentialId: string): boolean {
  return (
    account.credentials.some((credential) => credential.id === credentialId) &&
    account.credentials.length > 1
  );
}

/**
 * Authentication aggregate. A credential is logical: routing-key generations
 * and email aliases are persistence locators, not additional login methods.
 */
export const AccountIdentity = { create, canUnlink };
