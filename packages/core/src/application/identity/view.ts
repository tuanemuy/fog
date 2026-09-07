import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";

export type CredentialView = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  label: string;
  usableForLogin: boolean;
}>;

export type CurrentUserView = Readonly<{
  userId: string;
  email: string;
  credentials: readonly CredentialView[];
  trashRetentionDays: number;
}>;
