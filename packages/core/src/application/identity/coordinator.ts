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
  DirectoryReference,
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
  newUserId: () => UserId;
}>;

async function fingerprint(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

  private async compensateCreate(input: {
    operationId: IdentityRegistration["operationId"];
    userId: UserId;
    directoryReferences: readonly DirectoryReference[];
    accountEpoch: number;
    now: number;
  }): Promise<void> {
    await Promise.allSettled(
      input.directoryReferences.map((directoryReference) =>
        this.ports.directory.tombstone({
          operationId: input.operationId,
          directoryReference,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
    await this.ports.accountHome.compensateCreate({
      operationId: input.operationId,
      userId: input.userId,
      now: input.now,
    });
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
    const directoryReferences =
      await this.ports.directory.references(canonical);
    const credentialId = `password:${input.operationId}`;
    if (directoryReferences.length === 0) {
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
      ...directoryReferences,
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
      try {
        const prior = (
          await this.ports.directory.lookupCredential(canonical)
        ).filter((item) => item !== null);
        if (prior.some((item) => item.userId !== input.userId)) {
          throw new ConflictError(
            "CREDENTIAL_ALREADY_REGISTERED",
            "Credential is already registered",
          );
        }
        for (const directoryReference of directoryReferences) {
          await this.ports.directory.reserve({
            operationId: input.operationId,
            userId: input.userId,
            directoryReference,
            credentialId,
            credential: {
              kind: "password",
              canonicalValue: canonical,
              passwordHash: input.passwordHash,
            },
            accountEpoch: operation.epoch,
            now: input.now,
          });
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          await this.compensateCreate({
            operationId: input.operationId,
            userId: input.userId,
            directoryReferences,
            accountEpoch: operation.epoch,
            now: input.now,
          });
        }
        throw error;
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        directoryReference: directoryReferences[0],
        credential: {
          credentialId,
          kind: "password",
          email: input.email,
          passwordHash: input.passwordHash,
        },
        primaryEmail: input.email,
        now: input.now,
      });
      for (const directoryReference of directoryReferences.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
          credential: {
            credentialId,
            kind: "password",
            email: input.email,
            passwordHash: input.passwordHash,
          },
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
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
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
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
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
        credential: {
          credentialId,
          kind: "password",
          email: input.email,
          passwordHash: input.passwordHash,
        },
        primaryEmail: input.email,
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
    AccountIdentity.create({
      id: authority.userId,
      status: "active",
      primaryEmail: authority.primaryEmail,
      credentials: authority.credentials.map(
        ({ directoryReferences: _, ...credential }) => credential,
      ),
      sessionEpoch: authority.sessionEpoch,
    });
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
    let sagaUserId: UserId | null = null;
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
            authority?.credentials.some((credential) =>
              credential.directoryReferences.includes(item.directoryReference),
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
    if (sagaUserId === null) {
      sagaUserId = (
        await this.ports.directory.prepareSsoCreate({
          operationId: input.operationId,
          proposedUserId: this.ports.newUserId(),
          provider: input.provider,
          subject,
          email: input.email,
          now: input.now,
        })
      ).userId;
    }
    const sagaAccountId = sagaUserId;
    if (
      emailFound.some(
        (item) =>
          item !== null &&
          (item.userId !== sagaAccountId ||
            item.operationId !== input.operationId),
      )
    ) {
      throw new ConflictError(
        "CREDENTIAL_ALREADY_REGISTERED",
        "Credential is already registered",
      );
    }

    const providerReferences =
      await this.ports.directory.references(providerCredential);
    const emailReferences =
      await this.ports.directory.references(emailCredential);
    const directoryReferences = [...providerReferences, ...emailReferences];
    const credentialId = `sso:${input.operationId}`;
    const logicalCredential = {
      credentialId,
      kind: "sso" as const,
      provider: input.provider,
      subject,
      verifiedEmail: input.email,
    };
    if (providerReferences.length === 0) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO credential has no active locator",
      );
    }
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: sagaAccountId,
      kind: "sso-create",
      payloadDigest: await fingerprint([
        input.provider,
        subject,
        input.email,
        sagaAccountId,
      ]),
      primaryEmail: input.email,
      now: input.now,
    });
    if (!reached(operation, "credential-reserved")) {
      try {
        for (const directoryReference of directoryReferences) {
          await this.ports.directory.reserve({
            operationId: input.operationId,
            userId: sagaAccountId,
            directoryReference,
            credentialId,
            credential: {
              kind: "sso",
              canonicalValue: providerReferences.includes(directoryReference)
                ? providerCredential
                : emailCredential,
              provider: input.provider,
              verifiedEmail: input.email,
            },
            accountEpoch: operation.epoch,
            now: input.now,
          });
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          await this.compensateCreate({
            operationId: input.operationId,
            userId: sagaAccountId,
            directoryReferences,
            accountEpoch: operation.epoch,
            now: input.now,
          });
        }
        throw error;
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaAccountId,
        expectedState: "pending",
        nextState: "credential-reserved",
        directoryReference: directoryReferences[0],
        credential: logicalCredential,
        primaryEmail: input.email,
        now: input.now,
      });
      for (const directoryReference of directoryReferences.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: sagaAccountId,
          directoryReference,
          credential: logicalCredential,
          primaryEmail: input.email,
          bumpSessionEpoch: false,
          now: input.now,
        });
      }
    }
    if (!reached(operation, "user-data-initialized")) {
      await this.ports.userData.initialize({
        operationId: input.operationId,
        userId: sagaAccountId,
        now: input.now,
      });
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: sagaAccountId,
          directoryReference,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaAccountId,
        expectedState: "credential-reserved",
        nextState: "user-data-initialized",
        now: input.now,
      });
    }
    if (!reached(operation, "directory-active")) {
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: sagaAccountId,
          directoryReference,
          accountEpoch: operation.epoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaAccountId,
        expectedState: "user-data-initialized",
        nextState: "directory-active",
        now: input.now,
      });
    }
    if (!reached(operation, "completed")) {
      await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: sagaAccountId,
        expectedState: "directory-active",
        nextState: "completed",
        credential: logicalCredential,
        primaryEmail: input.email,
        now: input.now,
      });
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(sagaAccountId),
      sagaAccountId,
    );
    if (!authority) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "SSO operation completed without active authority",
      );
    }
    AccountIdentity.create({
      id: authority.userId,
      status: "active",
      primaryEmail: authority.primaryEmail,
      credentials: authority.credentials.map(
        ({ directoryReferences: _, ...credential }) => credential,
      ),
      sessionEpoch: authority.sessionEpoch,
    });
    return {
      userId: sagaAccountId,
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
          directoryReference: mapping.directoryReference,
        }),
      ),
    );
  }

  async requestPasswordReset(
    input: Parameters<IdentityPrimitivePort["requestPasswordReset"]>[0],
  ): Promise<{ accepted: true }> {
    const resetSecret = crypto.randomUUID();
    const tokenHash = await fingerprint(["password-reset-token", resetSecret]);
    const mappings = (
      await this.ports.directory.lookupPassword(input.email)
    ).filter((item): item is PasswordCredential => item !== null);
    const first = mappings[0];
    if (!first) return { accepted: true };
    if (
      mappings.some(
        (item) =>
          item.userId !== first.userId ||
          item.passwordHash !== first.passwordHash ||
          item.accountEpoch !== first.accountEpoch,
      )
    ) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Reset request generations disagree on password authority",
      );
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(first.userId),
      first.userId,
    );
    if (!authority) return { accepted: true };
    await Promise.all(
      mappings.map((mapping) =>
        this.ports.directory.storePasswordReset({
          operationId: input.operationId,
          directoryReference: mapping.directoryReference,
          userId: first.userId,
          tokenHash,
          expiresAt: input.expiresAt,
        }),
      ),
    );
    await this.ports.directory.enqueuePasswordResetMail({
      operationId: input.operationId,
      directoryReference: first.directoryReference,
      userId: first.userId,
      email: input.email,
      resetSecret,
      expiresAt: input.expiresAt,
      providerIdempotencyKey: `password-reset:${input.operationId}`,
      now: input.now,
    });
    return { accepted: true };
  }

  async changePassword(
    input: Parameters<IdentityPrimitivePort["changePassword"]>[0],
  ): Promise<{ sessionEpoch: number }> {
    const mappings = (
      await this.ports.directory.lookupPassword(input.email)
    ).filter((item): item is PasswordCredential => item !== null);
    if (
      mappings.length === 0 ||
      mappings.some((item) => item.userId !== input.userId)
    ) {
      throw new ConflictError(
        "ACCOUNT_AUTHORITY_MISMATCH",
        "Password credential is unavailable",
      );
    }
    const authority = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    const credential = authority?.credentials.find(
      (item) =>
        item.kind === "password" &&
        mappings.every((mapping) =>
          item.directoryReferences.includes(mapping.directoryReference),
        ),
    );
    if (!authority || !credential || credential.kind !== "password") {
      throw new ConflictError(
        "ACCOUNT_AUTHORITY_MISMATCH",
        "Password credential is unavailable",
      );
    }
    let operation = await this.ports.accountHome.beginOperation({
      operationId: input.operationId,
      userId: input.userId,
      kind: "password-change",
      payloadDigest: await fingerprint([
        "password-change",
        input.userId,
        input.email,
        input.passwordHash,
      ]),
      now: input.now,
    });
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
      for (const mapping of mappings) {
        await this.ports.directory.replacePassword({
          operationId: input.operationId,
          directoryReference: mapping.directoryReference,
          userId: input.userId,
          passwordHash: input.passwordHash,
          accountEpoch: authority.operationEpoch,
          now: input.now,
        });
      }
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "credential-reserved",
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
        credential: {
          ...credential,
          passwordHash: input.passwordHash,
        },
        bumpSessionEpoch: true,
        now: input.now,
      });
    }
    const updated = activeAuthority(
      await this.ports.accountHome.getAuthSummary(input.userId),
      input.userId,
    );
    if (!updated) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Password change completed without active authority",
      );
    }
    AccountIdentity.replacePassword(
      AccountIdentity.create({
        id: authority.userId,
        status: "active",
        primaryEmail: authority.primaryEmail,
        credentials: authority.credentials.map(
          ({ directoryReferences: _, ...item }) => item,
        ),
        sessionEpoch: authority.sessionEpoch,
      }),
      credential.credentialId,
      input.passwordHash,
    );
    return { sessionEpoch: updated.sessionEpoch };
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
    const directoryReferences = await this.ports.directory.references(
      `email:${input.email.normalize("NFKC")}`,
    );
    const candidates: Array<{
      userId: UserId;
      directoryReference: DirectoryReference;
    }> = [];
    for (const directoryReference of directoryReferences) {
      const result = await this.ports.directory.lookupPasswordReset({
        operationId: input.operationId,
        directoryReference,
        tokenHash: input.tokenHash,
        now: input.now,
      });
      if (result) candidates.push({ ...result, directoryReference });
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
          candidate.directoryReferences.includes(item.directoryReference),
        ) &&
        candidate.directoryReferences.every((directoryReference) =>
          candidates.some(
            (item) => item.directoryReference === directoryReference,
          ),
        ),
    );
    if (credential?.kind !== "password") {
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
          directoryReference: item.directoryReference,
          tokenHash: input.tokenHash,
          now: input.now,
        });
        if (!consumed || consumed.userId !== first.userId) return null;
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
          directoryReference: item.directoryReference,
          userId: first.userId,
          passwordHash: input.passwordHash,
          accountEpoch: authority.operationEpoch,
          now: input.now,
        });
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
        credential: {
          ...credential,
          passwordHash: input.passwordHash,
        },
        bumpSessionEpoch: true,
        now: input.now,
      });
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
    AccountIdentity.replacePassword(
      AccountIdentity.create({
        id: authority.userId,
        status: "active",
        primaryEmail: authority.primaryEmail,
        credentials: authority.credentials.map(
          ({ directoryReferences: _, ...item }) => item,
        ),
        sessionEpoch: authority.sessionEpoch,
      }),
      credential.credentialId,
      input.passwordHash,
    );
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
    const directoryReferences =
      await this.ports.directory.references(canonical);
    const credentialId = `sso:${input.operationId}`;
    const logicalCredential = {
      credentialId,
      kind: "sso" as const,
      provider: input.provider,
      subject,
      verifiedEmail: input.email,
    };
    if (directoryReferences.length === 0) {
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
      AccountIdentity.addCredential(
        AccountIdentity.create({
          id: authority.userId,
          status: "active",
          primaryEmail: authority.primaryEmail,
          credentials: authority.credentials.map(
            ({ directoryReferences: _, ...credential }) => credential,
          ),
          sessionEpoch: authority.sessionEpoch,
        }),
        logicalCredential,
      );
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.reserve({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
          credentialId,
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
      operation = await this.ports.accountHome.advanceOperation({
        operationId: input.operationId,
        userId: input.userId,
        expectedState: "pending",
        nextState: "credential-reserved",
        directoryReference: directoryReferences[0],
        credential: logicalCredential,
        now: input.now,
      });
      for (const directoryReference of directoryReferences.slice(1)) {
        await this.ports.accountHome.addCredentialLocator({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
          credential: logicalCredential,
          bumpSessionEpoch: false,
          now: input.now,
        });
      }
    }
    if (!reached(operation, "user-data-initialized")) {
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.markInitialized({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
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
      for (const directoryReference of directoryReferences) {
        await this.ports.directory.activate({
          operationId: input.operationId,
          userId: input.userId,
          directoryReference,
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
        credential: logicalCredential,
        bumpSessionEpoch: true,
        now: input.now,
      });
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
        input.credentialId,
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
    const target = authority.credentials.find(
      (credential) => credential.credentialId === input.credentialId,
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
      status: "active",
      primaryEmail: authority.primaryEmail,
      credentials: authority.credentials.map(
        ({ directoryReferences: _, ...credential }) => credential,
      ),
      sessionEpoch: authority.sessionEpoch,
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
      AccountIdentity.unlink(accountIdentity, target.credentialId);
      for (const directoryReference of target.directoryReferences) {
        await this.ports.directory.tombstone({
          operationId: input.operationId,
          directoryReference,
          userId: input.userId,
          accountEpoch: authority.operationEpoch,
          now: input.now,
        });
      }
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
  }

  async deleteAccount(
    input: Parameters<IdentityPrimitivePort["deleteAccount"]>[0],
  ): Promise<void> {
    const deletion = await this.ports.accountHome.beginDeletion(input);
    if (deletion.state === "completed") return;
    for (const directoryReference of deletion.directoryReferences) {
      await this.ports.directory.tombstone({
        operationId: input.operationId,
        directoryReference,
        userId: input.userId,
        accountEpoch: deletion.epoch,
        now: input.now,
      });
    }
    await this.ports.userData.deleteAll(input);
    for (const directoryReference of deletion.directoryReferences) {
      await this.ports.directory.purge({
        operationId: input.operationId,
        directoryReference,
        userId: input.userId,
        accountEpoch: deletion.epoch,
      });
    }
    await this.ports.accountHome.finishDeletion({
      ...input,
      epoch: deletion.epoch,
    });
  }
}
