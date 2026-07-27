import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  Email,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type {
  AccountAuthSummary,
  AccountHomePort,
  CredentialDirectoryPort,
  CredentialLocator,
  CurrentAccount,
  IdentityApplicationPort,
  IdentityOperation,
  IdentityOperationState,
  IdentityPrimitivePort,
  IdentityRegistration,
  PasswordCredential,
  SsoCredentialInput,
  UserDataIdentityPort,
} from "./contracts";

type Ports = Readonly<{
  directory: CredentialDirectoryPort;
  accountHome: AccountHomePort;
  userData: UserDataIdentityPort;
}>;

function fingerprint(parts: readonly string[]): string {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (const byte of new TextEncoder().encode(parts.join("\u0000"))) {
    left = Math.imul(left ^ byte, 0x01000193);
    right = Math.imul(right ^ (byte + 17), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function sameLocator(
  left: CredentialLocator,
  right: CredentialLocator,
): boolean {
  return (
    left.generation === right.generation &&
    left.bucket === right.bucket &&
    left.opaqueKey === right.opaqueKey
  );
}

const SIGNUP_PHASES: readonly IdentityOperationState[] = [
  "pending",
  "credential-reserved",
  "user-data-initialized",
  "directory-active",
  "completed",
];

function reached(
  operation: IdentityOperation,
  state: IdentityOperationState,
): boolean {
  const current = SIGNUP_PHASES.indexOf(operation.state);
  const expected = SIGNUP_PHASES.indexOf(state);
  return current >= expected && expected >= 0;
}

function activeAuthority(
  authority: AccountAuthSummary | null,
  userId: UserId,
): AccountAuthSummary | null {
  return authority?.status === "active" && authority.userId === userId
    ? authority
    : null;
}

/**
 * Owns identity saga ordering and phase recovery. Provider adapters expose
 * only persistence/routing primitives; no adapter decides a business phase.
 */
export class IdentityCoordinator
  implements IdentityApplicationPort, IdentityPrimitivePort
{
  constructor(private readonly ports: Ports) {}

  async registerWithPassword(
    input: IdentityRegistration,
  ): Promise<{ sessionEpoch: number }> {
    const canonical = `email:${input.email.normalize("NFKC")}`;
    const locators = await this.ports.directory.locators(canonical);
    const payloadDigest = fingerprint([
      "signup",
      input.userId,
      input.email,
      input.passwordHash,
      ...locators.map(
        (locator) =>
          `${locator.generation}:${locator.bucket}:${locator.opaqueKey}`,
      ),
    ]);
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: input.userId,
      kind: "signup",
      payloadDigest,
      primaryEmail: input.email,
      now: input.now,
    });

    if (!reached(operation, "credential-reserved")) {
      const prior = (
        await this.ports.directory.lookupCredential(canonical)
      ).filter((item) => item !== null);
      if (prior.some((item) => item.userId !== input.userId)) {
        throw new ConflictError(
          "CREDENTIAL_ALREADY_REGISTERED",
          "Credential is already registered",
        );
      }
      for (const locator of locators) {
        await this.ports.directory.reserve({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          credential: {
            kind: "password",
            canonicalValue: canonical,
            passwordHash: input.passwordHash,
          },
          accountEpoch: operation.epoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        locator: locators[0],
        credentialKind: "password",
        primaryEmail: input.email,
        now: input.now,
      });
      for (const locator of locators.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          kind: "password",
          primaryEmail: input.email,
          bumpSessionEpoch: false,
          now: input.now,
        });
      }
    }

    if (!reached(operation, "user-data-initialized")) {
      await this.ports.userData.initialize({
        operationId: input.operationId,
        userId: input.userId,
        now: input.now,
      });
      for (const locator of locators) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "credential-reserved",
        nextState: "user-data-initialized",
        now: input.now,
      });
    }

    if (!reached(operation, "directory-active")) {
      for (const locator of locators) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          accountEpoch: operation.epoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "user-data-initialized",
        nextState: "directory-active",
        now: input.now,
      });
    }

    if (!reached(operation, "completed")) {
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "directory-active",
        nextState: "completed",
        now: input.now,
      });
    }

    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!authority || operation.state !== "completed") {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Signup completed without an active Account Home authority",
      );
    }
    return { sessionEpoch: authority.sessionEpoch };
  }

  async findPasswordCredential(
    email: Email,
  ): Promise<PasswordCredential | null> {
    const results = await this.ports.directory.lookupPassword(email);
    const found = results.filter(
      (item): item is PasswordCredential => item !== null,
    );
    const userIds = new Set(found.map((item) => item.userId));
    if (userIds.size > 1) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Credential generations resolve to different accounts",
      );
    }
    return found[0] ?? null;
  }

  getAccountAuthority(userId: UserId): Promise<AccountAuthSummary | null> {
    return this.ports.accountHome.getAuthSummary(userId);
  }

  async getCurrentAccount(userId: UserId): Promise<CurrentAccount | null> {
    const [auth, profile] = await Promise.all([
      this.ports.accountHome.getAuthSummary(userId),
      this.ports.userData.getProfile(userId),
    ]);
    const active = activeAuthority(auth, userId);
    if (!active) return null;
    if (!profile || profile.userId !== userId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "User Data owner does not match Account Home",
      );
    }
    return { auth: active, profile };
  }

  async lookupOrCreateSso(
    input: SsoCredentialInput,
  ): Promise<{ userId: UserId; sessionEpoch: number }> {
    const providerCredential = `sso:${input.provider}\u0000${input.subject.normalize("NFKC")}`;
    const emailCredential = `email:${input.email.normalize("NFKC")}`;
    const [providerFound, emailFound] = await Promise.all([
      this.ports.directory.lookupCredential(providerCredential),
      this.ports.directory.lookupCredential(emailCredential),
    ]);
    const existingProvider = providerFound.find(
      (item) => item?.state === "active",
    );
    if (existingProvider) {
      const authority = activeAuthority(
        await this.ports.accountHome.getAuthSummary(existingProvider.userId),
        existingProvider.userId,
      );
      if (!authority) {
        throw new ConflictError(
          "INVALID_SSO_CREDENTIAL",
          "SSO credential is unavailable",
        );
      }
      return {
        userId: existingProvider.userId,
        sessionEpoch: authority.sessionEpoch,
      };
    }
    if (emailFound.some((item) => item !== null)) {
      throw new ConflictError(
        "CREDENTIAL_ALREADY_REGISTERED",
        "Credential is already registered",
      );
    }

    const providerLocators =
      await this.ports.directory.locators(providerCredential);
    const emailLocators = await this.ports.directory.locators(emailCredential);
    const locators = [...providerLocators, ...emailLocators];
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: input.proposedUserId,
      kind: "sso-create",
      payloadDigest: fingerprint([
        input.provider,
        input.subject,
        input.email,
        input.proposedUserId,
      ]),
      primaryEmail: input.email,
      now: input.now,
    });
    if (!reached(operation, "credential-reserved")) {
      for (const locator of locators) {
        await this.ports.directory.reserve({
          operationId: input.operationId,
          userId: input.proposedUserId,
          locator,
          credential: {
            kind: "sso",
            canonicalValue: providerLocators.some((item) =>
              sameLocator(item, locator),
            )
              ? providerCredential
              : emailCredential,
            provider: input.provider,
            verifiedEmail: input.email,
          },
          accountEpoch: operation.epoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.proposedUserId,
        expectedState: "pending",
        nextState: "credential-reserved",
        locator: locators[0],
        credentialKind: "sso",
        primaryEmail: input.email,
        now: input.now,
      });
      for (const locator of locators.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.proposedUserId,
          locator,
          kind: "sso",
          primaryEmail: input.email,
          bumpSessionEpoch: false,
          now: input.now,
        });
      }
    }
    if (!reached(operation, "user-data-initialized")) {
      await this.ports.userData.initialize({
        operationId: input.operationId,
        userId: input.proposedUserId,
        now: input.now,
      });
      for (const locator of locators) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: input.proposedUserId,
          locator,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.proposedUserId,
        expectedState: "credential-reserved",
        nextState: "user-data-initialized",
        now: input.now,
      });
    }
    if (!reached(operation, "directory-active")) {
      for (const locator of locators) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: input.proposedUserId,
          locator,
          accountEpoch: operation.epoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.proposedUserId,
        expectedState: "user-data-initialized",
        nextState: "directory-active",
        now: input.now,
      });
    }
    if (!reached(operation, "completed")) {
      await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.proposedUserId,
        expectedState: "directory-active",
        nextState: "completed",
        now: input.now,
      });
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.proposedUserId),
      input.proposedUserId,
    );
    if (!authority) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO operation completed without active authority",
      );
    }
    return {
      userId: input.proposedUserId,
      sessionEpoch: authority.sessionEpoch,
    };
  }

  async storePasswordReset(
    input: Parameters<IdentityPrimitivePort["storePasswordReset"]>[0],
  ): Promise<void> {
    const locators = await this.ports.directory.locators(
      `email:${input.email.normalize("NFKC")}`,
    );
    await Promise.all(
      locators.map((locator) =>
        this.ports.directory.storePasswordReset({ ...input, locator }),
      ),
    );
  }

  async consumePasswordReset(input: {
    operationId: Parameters<
      IdentityPrimitivePort["consumePasswordReset"]
    >[0]["operationId"];
    tokenHash: string;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): Promise<{ userId: UserId; sessionEpoch: number } | null> {
    const locators = await this.ports.directory.locators(
      `email:${input.email.normalize("NFKC")}`,
    );
    const consumed: Array<{ userId: UserId; locator: CredentialLocator }> = [];
    for (const locator of locators) {
      const result = await this.ports.directory.consumePasswordReset({
        operationId: input.operationId,
        locator,
        tokenHash: input.tokenHash,
        now: input.now,
      });
      if (result) consumed.push({ ...result, locator });
    }
    const first = consumed[0];
    if (!first) return null;
    if (consumed.some((item) => item.userId !== first.userId)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Reset token generations resolve to different accounts",
      );
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(first.userId),
      first.userId,
    );
    if (!authority) return null;
    let updated = authority;
    for (const item of consumed) {
      await this.ports.directory.replacePassword({
        operationId: input.operationId,
        locator: item.locator,
        userId: first.userId,
        passwordHash: input.passwordHash,
        accountEpoch: authority.operationEpoch,
        now: input.now,
      });
      updated = await this.ports.accountHome.addCredentialLocator({
        operationId: input.operationId,
        userId: first.userId,
        locator: item.locator,
        kind: "password",
        primaryEmail: input.email,
        bumpSessionEpoch: true,
        now: input.now,
      });
    }
    return { userId: first.userId, sessionEpoch: updated.sessionEpoch };
  }

  async linkSso(input: SsoCredentialInput & { userId: UserId }): Promise<void> {
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!authority || authority.primaryEmail !== input.email) {
      throw new ConflictError(
        "ACCOUNT_AUTHORITY_MISMATCH",
        "Credential cannot be linked",
      );
    }
    const canonical = `sso:${input.provider}\u0000${input.subject.normalize("NFKC")}`;
    const existing = await this.ports.directory.lookupCredential(canonical);
    if (existing.some((item) => item !== null)) {
      throw new ConflictError(
        "CREDENTIAL_ALREADY_REGISTERED",
        "Credential is already registered",
      );
    }
    for (const locator of await this.ports.directory.locators(canonical)) {
      await this.ports.directory.reserve({
        operationId: input.operationId,
        userId: input.userId,
        locator,
        credential: {
          kind: "sso",
          canonicalValue: canonical,
          provider: input.provider,
          verifiedEmail: input.email,
        },
        accountEpoch: authority.operationEpoch,
        now: input.now,
      });
      await this.ports.directory.markInitialized({
        operationId: input.operationId,
        userId: input.userId,
        locator,
        now: input.now,
      });
      await this.ports.directory.activate({
        operationId: input.operationId,
        userId: input.userId,
        locator,
        accountEpoch: authority.operationEpoch,
        now: input.now,
      });
      await this.ports.accountHome.addCredentialLocator({
        operationId: input.operationId,
        userId: input.userId,
        locator,
        kind: "sso",
        bumpSessionEpoch: true,
        now: input.now,
      });
    }
  }

  async unlinkCredential(
    input: Parameters<IdentityPrimitivePort["unlinkCredential"]>[0],
  ): Promise<void> {
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!authority) {
      throw new ConflictError("ACCOUNT_INACTIVE", "Account is not active");
    }
    const remaining = authority.locators.filter(
      (locator) => !sameLocator(locator, input.locator),
    );
    if (remaining.length === 0) {
      throw new ConflictError(
        "LAST_CREDENTIAL_UNLINK_FORBIDDEN",
        "The last login credential cannot be removed",
      );
    }
    await this.ports.directory.tombstone({
      operationId: input.operationId,
      locator: input.locator,
      accountEpoch: authority.operationEpoch,
      now: input.now,
    });
    await this.ports.accountHome.removeCredentialLocator({
      operationId: input.operationId,
      userId: input.userId,
      locator: input.locator,
      bumpSessionEpoch: true,
      now: input.now,
    });
  }

  async deleteAccount(
    input: Parameters<IdentityPrimitivePort["deleteAccount"]>[0],
  ): Promise<void> {
    const deletion = await this.ports.accountHome.beginDeletion(input);
    if (deletion.state === "completed") return;
    for (const locator of deletion.locators) {
      await this.ports.directory.tombstone({
        operationId: input.operationId,
        locator,
        accountEpoch: deletion.epoch,
        now: input.now,
      });
    }
    await this.ports.userData.deleteAll(input);
    for (const locator of deletion.locators) {
      await this.ports.directory.purge({
        operationId: input.operationId,
        locator,
        accountEpoch: deletion.epoch,
      });
    }
    await this.ports.accountHome.finishDeletion({
      ...input,
      epoch: deletion.epoch,
    });
  }
}
