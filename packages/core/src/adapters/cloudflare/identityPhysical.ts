import type {
  CredentialState,
  OperationId,
} from "@repo/core/application/identity/contracts";
import type {
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";

declare const opaqueCredentialKeyBrand: unique symbol;

export type OpaqueCredentialKey = string & {
  readonly [opaqueCredentialKeyBrand]: true;
};

export function opaqueCredentialKey(raw: string): OpaqueCredentialKey {
  if (raw.length === 0 || raw.length > 256) {
    throw new TypeError("opaque credential key is malformed");
  }
  return raw as OpaqueCredentialKey;
}

export type PhysicalCredentialLocator = Readonly<{
  generation: string;
  bucket: number;
  opaqueKey: OpaqueCredentialKey;
}>;

export type StoredCredentialRef =
  | Readonly<{
      credentialId: string;
      kind: "password";
      canonicalValueEncrypted: string;
      emailEncrypted: string;
      passwordHash: PasswordHash;
    }>
  | Readonly<{
      credentialId: string;
      kind: "sso";
      canonicalValueEncrypted: string;
      provider: string;
      subjectEncrypted: string;
      verifiedEmailEncrypted: string;
    }>;

export type StoredDirectoryCredential = Readonly<{
  userId: UserId;
  operationId: OperationId;
  locator: PhysicalCredentialLocator;
  state: CredentialState;
  accountEpoch: number;
  credential: StoredCredentialRef;
}>;
