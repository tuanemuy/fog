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
import { SsoSubject } from "@repo/core/domain/identity/valueObject";
import { AccountIdentity } from "@repo/core/domain/identity/accountIdentity";
import type {
  AccountAuthSummary,
  AccountHomePort,
  CredentialDirectoryPort,
  CredentialLocator,
  CurrentAccount,
  DirectoryCredential,
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

export type IdentitySagaFaultPoint =
  | "signup-after-reserve"
  | "signup-after-initialize"
  | "signup-after-finalize"
  | "sso-after-provider-reserve"
  | "sso-after-email-reserve"
  | "sso-after-provider-activate"
  | "sso-after-email-activate"
  | "link-after-reserve"
  | "link-after-activate"
  | "link-after-finalize"
  | "unlink-after-directory"
  | "unlink-after-authority"
  | "reset-after-consume"
  | "reset-after-hash"
  | "reset-after-epoch"
  | "delete-after-user-data"
  | "delete-after-directory"
  | "delete-after-finish";

export type IdentitySagaFaultHook = (
  point: IdentitySagaFaultPoint,
) => void | Promise<void>;

async function fingerprint(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  constructor(
    private readonly ports: Ports,
    private readonly faultHook?: IdentitySagaFaultHook,
  ) {}

  private async checkpoint(point: IdentitySagaFaultPoint): Promise<void> {
    await this.faultHook?.(point);
  }

  preparePasswordSignup(
    input: Parameters<IdentityApplicationPort["preparePasswordSignup"]>[0],
  ): ReturnType<IdentityApplicationPort["preparePasswordSignup"]> {
    return this.ports.directory.preparePasswordSignup(input);
  }

  async registerWithPassword(
    input: IdentityRegistration,
  ): Promise<{ sessionEpoch: number }> {
    const canonical = `email:${input.email.normalize("NFKC")}`;
    const locators = await this.ports.directory.locators(canonical);
    const credentialId = locators[0]?.opaqueKey;
    if (!credentialId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Password credential has no active locator",
      );
    }
    const payloadDigest = await fingerprint([
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
      await this.checkpoint("signup-after-reserve");
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        locator: locators[0],
        credentialId,
        credentialKind: "password",
        primaryEmail: input.email,
        now: input.now,
      });
      for (const locator of locators.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          credentialId,
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
      await this.checkpoint("signup-after-initialize");
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
        credentialId,
        credentialKind: "password",
        primaryEmail: input.email,
        now: input.now,
      });
      await this.checkpoint("signup-after-finalize");
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
    const hashes = new Set(found.map((item) => item.passwordHash));
    const epochs = new Set(found.map((item) => item.accountEpoch));
    if (userIds.size > 1 || hashes.size > 1 || epochs.size > 1) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Credential generations disagree on password authority",
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
    const subject = SsoSubject.create(input.subject);
    const providerCredential = `sso:${input.provider}\u0000${subject}`;
    const emailCredential = `email:${input.email.normalize("NFKC")}`;
    const [providerFound, emailFound] = await Promise.all([
      this.ports.directory.lookupCredential(providerCredential),
      this.ports.directory.lookupCredential(emailCredential),
    ]);
    const existingProvider = providerFound.find(
      (item) => item?.state === "active",
    );
    let sagaUserId = input.proposedUserId;
    if (existingProvider) {
      const rawAuthority = await this.ports.accountHome.getAuthSummary(
        existingProvider.userId,
      );
      const authority = activeAuthority(rawAuthority, existingProvider.userId);
      const providerMappings = providerFound.filter(
        (item): item is DirectoryCredential => item !== null,
      );
      const consistent =
        providerMappings.length > 0 &&
        providerMappings.every(
          (item) =>
            item.userId === existingProvider.userId &&
            item.accountEpoch === authority?.operationEpoch &&
            authority?.locators.some((locator) =>
              sameLocator(locator, item.locator),
            ),
        );
      if (!authority || !consistent) {
        const operation = await this.ports.accountHome.getOperation(
          existingProvider.userId,
          input.operationId,
        );
        const resumable =
          operation?.kind === "sso-create" &&
          operation.state !== "completed" &&
          providerMappings.every(
            (item) =>
              item.userId === existingProvider.userId &&
              item.operationId === input.operationId,
          );
        if (!resumable) {
          throw new ConflictError(
            "INVALID_SSO_CREDENTIAL",
            "SSO credential is unavailable",
          );
        }
        sagaUserId = existingProvider.userId;
      } else {
        return {
          userId: existingProvider.userId,
          sessionEpoch: authority.sessionEpoch,
        };
      }
    } else {
      const resumableProvider = providerFound.find(
        (item) => item?.operationId === input.operationId,
      );
      if (resumableProvider) {
        if (
          providerFound.some(
            (item) =>
              item !== null &&
              (item.userId !== resumableProvider.userId ||
                item.operationId !== input.operationId),
          )
        ) {
          throw new ConflictError(
            "INVALID_SSO_CREDENTIAL",
            "SSO credential is unavailable",
          );
        }
        sagaUserId = resumableProvider.userId;
      }
    }
    if (
      emailFound.some(
        (item) =>
          item !== null &&
          (item.userId !== sagaUserId ||
            item.operationId !== input.operationId),
      )
    ) {
      throw new ConflictError(
        "CREDENTIAL_ALREADY_REGISTERED",
        "Credential is already registered",
      );
    }

    const providerLocators =
      await this.ports.directory.locators(providerCredential);
    const emailLocators = await this.ports.directory.locators(emailCredential);
    const locators = [...providerLocators, ...emailLocators];
    const credentialId = providerLocators[0]?.opaqueKey;
    if (!credentialId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO credential has no active locator",
      );
    }
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: sagaUserId,
      kind: "sso-create",
      payloadDigest: await fingerprint([
        input.provider,
        subject,
        input.email,
        sagaUserId,
      ]),
      primaryEmail: input.email,
      now: input.now,
    });
    if (!reached(operation, "credential-reserved")) {
      for (const locator of locators) {
        await this.ports.directory.reserve({
          operationId: input.operationId,
          userId: sagaUserId,
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
        await this.checkpoint(
          providerLocators.some((item) => sameLocator(item, locator))
            ? "sso-after-provider-reserve"
            : "sso-after-email-reserve",
        );
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaUserId,
        expectedState: "pending",
        nextState: "credential-reserved",
        locator: locators[0],
        credentialId,
        credentialKind: "sso",
        primaryEmail: input.email,
        now: input.now,
      });
      for (const locator of locators.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: sagaUserId,
          locator,
          credentialId,
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
        userId: sagaUserId,
        now: input.now,
      });
      for (const locator of locators) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: sagaUserId,
          locator,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaUserId,
        expectedState: "credential-reserved",
        nextState: "user-data-initialized",
        now: input.now,
      });
    }
    if (!reached(operation, "directory-active")) {
      for (const locator of locators) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: sagaUserId,
          locator,
          accountEpoch: operation.epoch,
          now: input.now,
        });
        await this.checkpoint(
          providerLocators.some((item) => sameLocator(item, locator))
            ? "sso-after-provider-activate"
            : "sso-after-email-activate",
        );
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaUserId,
        expectedState: "user-data-initialized",
        nextState: "directory-active",
        now: input.now,
      });
    }
    if (!reached(operation, "completed")) {
      await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaUserId,
        expectedState: "directory-active",
        nextState: "completed",
        credentialId,
        credentialKind: "sso",
        primaryEmail: input.email,
        now: input.now,
      });
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(sagaUserId),
      sagaUserId,
    );
    if (!authority) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO operation completed without active authority",
      );
    }
    return {
      userId: sagaUserId,
      sessionEpoch: authority.sessionEpoch,
    };
  }

  async storePasswordReset(
    input: Parameters<IdentityPrimitivePort["storePasswordReset"]>[0],
  ): Promise<void> {
    const mappings = (
      await this.ports.directory.lookupPassword(input.email)
    ).filter((item): item is PasswordCredential => item !== null);
    if (mappings.length === 0) return;
    if (
      mappings.some(
        (item) =>
          item.userId !== input.userId ||
          item.passwordHash !== mappings[0]?.passwordHash ||
          item.accountEpoch !== mappings[0]?.accountEpoch,
      )
    ) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Reset target generations disagree on password authority",
      );
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!authority) return;
    await Promise.all(
      mappings.map((mapping) =>
        this.ports.directory.storePasswordReset({
          ...input,
          locator: mapping.locator,
        }),
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
    const candidates: Array<{
      userId: UserId;
      locator: CredentialLocator;
    }> = [];
    for (const locator of locators) {
      const result = await this.ports.directory.lookupPasswordReset({
        operationId: input.operationId,
        locator,
        tokenHash: input.tokenHash,
        now: input.now,
      });
      if (result) candidates.push({ ...result, locator });
    }
    const first = candidates[0];
    if (!first) return null;
    if (candidates.some((item) => item.userId !== first.userId)) {
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
    const credential = authority.credentials.find(
      (candidate) =>
        candidate.kind === "password" &&
        candidates.every((item) =>
          candidate.locators.some((locator) =>
            sameLocator(locator, item.locator),
          ),
        ) &&
        candidate.locators.every((locator) =>
          candidates.some((item) => sameLocator(locator, item.locator)),
        ),
    );
    if (!credential) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Reset target is not one logical password credential",
      );
    }
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: first.userId,
      kind: "password-reset",
      payloadDigest: await fingerprint([
        "password-reset",
        input.tokenHash,
        input.email,
        input.passwordHash,
      ]),
      now: input.now,
    });
    if (!reached(operation, "credential-reserved")) {
      for (const item of candidates) {
        const consumed = await this.ports.directory.consumePasswordReset({
          operationId: input.operationId,
          locator: item.locator,
          tokenHash: input.tokenHash,
          now: input.now,
        });
        if (!consumed || consumed.userId !== first.userId) return null;
        await this.checkpoint("reset-after-consume");
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: first.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        now: input.now,
      });
    }
    if (!reached(operation, "directory-active")) {
      for (const item of candidates) {
        await this.ports.directory.replacePassword({
          operationId: input.operationId,
          locator: item.locator,
          userId: first.userId,
          passwordHash: input.passwordHash,
          accountEpoch: authority.operationEpoch,
          now: input.now,
        });
        await this.checkpoint("reset-after-hash");
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: first.userId,
        expectedState: "credential-reserved",
        nextState: "directory-active",
        now: input.now,
      });
    }
    if (!reached(operation, "completed")) {
      await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: first.userId,
        expectedState: "directory-active",
        nextState: "completed",
        credentialId: credential.credentialId,
        credentialKind: "password",
        bumpSessionEpoch: true,
        now: input.now,
      });
      await this.checkpoint("reset-after-epoch");
    }
    const updated = activeAuthority(
      await this.ports.accountHome.getAuthSummary(first.userId),
      first.userId,
    );
    if (!updated) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Password reset completed without active authority",
      );
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
    const subject = SsoSubject.create(input.subject);
    const canonical = `sso:${input.provider}\u0000${subject}`;
    const locators = await this.ports.directory.locators(canonical);
    const credentialId = locators[0]?.opaqueKey;
    if (!credentialId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO credential has no active locator",
      );
    }
    const existing = (
      await this.ports.directory.lookupCredential(canonical)
    ).filter((item): item is DirectoryCredential => item !== null);
    if (
      existing.some(
        (item) =>
          item.userId !== input.userId ||
          item.operationId !== input.operationId ||
          item.credential.kind !== "sso",
      )
    ) {
      throw new ConflictError(
        "CREDENTIAL_ALREADY_REGISTERED",
        "Credential is already registered",
      );
    }
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: input.userId,
      kind: "sso-link",
      payloadDigest: await fingerprint([
        "sso-link",
        input.userId,
        input.provider,
        subject,
        input.email,
      ]),
      now: input.now,
    });
    if (!reached(operation, "credential-reserved")) {
      for (const locator of locators) {
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
      }
      await this.checkpoint("link-after-reserve");
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        locator: locators[0],
        credentialId,
        credentialKind: "sso",
        now: input.now,
      });
      for (const locator of locators.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          credentialId,
          kind: "sso",
          bumpSessionEpoch: false,
          now: input.now,
        });
      }
    }
    if (!reached(operation, "user-data-initialized")) {
      for (const locator of locators) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: input.userId,
          locator,
          now: input.now,
        });
      }
      await this.checkpoint("link-after-activate");
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
          accountEpoch: authority.operationEpoch,
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
      await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "directory-active",
        nextState: "completed",
        credentialId,
        credentialKind: "sso",
        bumpSessionEpoch: true,
        now: input.now,
      });
      await this.checkpoint("link-after-finalize");
    }
  }

  async unlinkCredential(
    input: Parameters<IdentityPrimitivePort["unlinkCredential"]>[0],
  ): Promise<void> {
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: input.userId,
      kind: "sso-unlink",
      payloadDigest: await fingerprint([
        "sso-unlink",
        input.userId,
        input.locator.generation,
        String(input.locator.bucket),
        input.locator.opaqueKey,
      ]),
      now: input.now,
    });
    if (operation.state === "completed") return;
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!authority) {
      throw new ConflictError("ACCOUNT_INACTIVE", "Account is not active");
    }
    const target = authority.credentials.find((credential) =>
      credential.locators.some((locator) =>
        sameLocator(locator, input.locator),
      ),
    );
    if (!target) {
      throw new ConflictError(
        "ACCOUNT_AUTHORITY_MISMATCH",
        "Credential is not active for this account",
      );
    }
    if (authority.primaryEmail === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Active account has no primary email authority",
      );
    }
    const accountIdentity = AccountIdentity.create({
      id: authority.userId,
      primaryEmail: authority.primaryEmail,
      credentials: authority.credentials.map((credential) => ({
        id: credential.credentialId,
        kind: credential.kind,
      })),
    });
    if (!AccountIdentity.canUnlink(accountIdentity, target.credentialId)) {
      throw new ConflictError(
        "LAST_CREDENTIAL_UNLINK_FORBIDDEN",
        "The last login credential cannot be removed",
      );
    }
    if (!reached(operation, "credential-reserved")) {
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        now: input.now,
      });
    }
    if (!reached(operation, "directory-active")) {
      for (const locator of target.locators) {
        await this.ports.directory.tombstone({
          operationId: input.operationId,
          locator,
          userId: input.userId,
          accountEpoch: authority.operationEpoch,
          now: input.now,
        });
      }
      await this.checkpoint("unlink-after-directory");
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "credential-reserved",
        nextState: "directory-active",
        now: input.now,
      });
    }
    await this.ports.accountHome.removeCredentialLocator({
      operationId: input.operationId,
      userId: input.userId,
      credentialId: target.credentialId,
      bumpSessionEpoch: true,
      now: input.now,
    });
    await this.checkpoint("unlink-after-authority");
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
        userId: input.userId,
        accountEpoch: deletion.epoch,
        now: input.now,
      });
    }
    await this.ports.userData.deleteAll(input);
    await this.checkpoint("delete-after-user-data");
    for (const locator of deletion.locators) {
      await this.ports.directory.purge({
        operationId: input.operationId,
        locator,
        userId: input.userId,
        accountEpoch: deletion.epoch,
      });
      await this.checkpoint("delete-after-directory");
    }
    await this.ports.accountHome.finishDeletion({
      ...input,
      epoch: deletion.epoch,
    });
    await this.checkpoint("delete-after-finish");
  }
}
