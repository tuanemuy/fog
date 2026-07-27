import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type {
  CurrentAccount,
  IdentityApplicationPort,
  IdentityRegistration,
  PasswordCredential,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type { PasswordHash } from "@repo/core/domain/identity/valueObject";
import {
  canonicalPasswordCredential,
  credentialLocators,
  directoryObjectName,
  type DirectoryKeyring,
} from "./identityRouting";

type DirectoryStub = {
  reserve(input: {
    opaqueKey: string;
    generation: string;
    canonicalValue: string;
    kind: "password";
    userId: string;
    operationId: string;
    passwordHash: PasswordHash;
    now: number;
    reservationExpiresAt: number;
  }): Promise<RpcResult<{ userId: string }>>;
  activate(input: {
    opaqueKey: string;
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string }>>;
  lookupPassword(
    opaqueKey: string,
  ): Promise<RpcResult<PasswordCredential | null>>;
};

type AccountHomeStub = {
  beginSignup(input: {
    operationId: string;
    userId: string;
    email: string;
    opaqueKey: string;
    generation: string;
    now: number;
  }): Promise<RpcResult<{ state: string }>>;
  activateSignup(input: {
    operationId: string;
    opaqueKey: string;
    now: number;
  }): Promise<RpcResult<{ state: string }>>;
  current(): Promise<RpcResult<CurrentAccount | null>>;
};

type UserDataStub = {
  initialize(input: {
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string; trashRetentionDays: number }>>;
  getProfile(): Promise<
    RpcResult<{ userId: string; trashRetentionDays: number }>
  >;
};

type RetriableRpcError = Error & {
  retryable?: boolean;
  overloaded?: boolean;
};

function stub<T>(namespace: DurableObjectNamespace, name: string): T {
  return namespace.get(namespace.idFromName(name)) as unknown as T;
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  switch (result.error.kind) {
    case "conflict":
      throw new ConflictError(result.error.code, result.error.message);
    case "not-found":
      throw new NotFoundError(result.error.code, result.error.message);
    case "validation":
      throw new ValidationError(result.error.code, result.error.message);
    case "infrastructure":
      throw new SystemError(SystemErrorCode.NetworkError, result.error.message);
  }
}

async function retryIdempotent<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const rpcError = error as RetriableRpcError;
      if (
        rpcError.overloaded === true ||
        rpcError.retryable !== true ||
        attempt >= 2
      ) {
        throw error;
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

export class CloudflareIdentityGateway implements IdentityApplicationPort {
  constructor(
    private readonly directory: DurableObjectNamespace,
    private readonly accountHomes: DurableObjectNamespace,
    private readonly userData: DurableObjectNamespace,
    private readonly keyring: DirectoryKeyring,
  ) {}

  async registerWithPassword(input: IdentityRegistration): Promise<void> {
    const canonical = canonicalPasswordCredential(input.email);
    const locators = await credentialLocators(canonical, this.keyring);
    const active = locators.find(
      (locator) => locator.generation === this.keyring.active.generation,
    );
    if (!active) throw new Error("Active directory locator is missing");
    for (const locator of locators) {
      if (locator === active) continue;
      const found = unwrap(
        await retryIdempotent(() =>
          stub<DirectoryStub>(
            this.directory,
            directoryObjectName(locator),
          ).lookupPassword(locator.opaqueKey),
        ),
      );
      if (found) {
        throw new ConflictError(
          "EMAIL_ALREADY_REGISTERED",
          "That email address is already registered",
        );
      }
    }
    const directory = stub<DirectoryStub>(
      this.directory,
      directoryObjectName(active),
    );
    unwrap(
      await retryIdempotent(() =>
        directory.reserve({
          opaqueKey: active.opaqueKey,
          generation: active.generation,
          canonicalValue: canonical,
          kind: "password",
          userId: input.userId,
          operationId: input.operationId,
          passwordHash: input.passwordHash,
          now: input.now,
          reservationExpiresAt: input.now + 15 * 60_000,
        }),
      ),
    );
    const home = stub<AccountHomeStub>(this.accountHomes, input.userId);
    unwrap(
      await retryIdempotent(() =>
        home.beginSignup({
          operationId: input.operationId,
          userId: input.userId,
          email: input.email,
          opaqueKey: active.opaqueKey,
          generation: active.generation,
          now: input.now,
        }),
      ),
    );
    unwrap(
      await retryIdempotent(() =>
        stub<UserDataStub>(this.userData, input.userId).initialize({
          operationId: input.operationId,
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
    unwrap(
      await retryIdempotent(() =>
        directory.activate({
          opaqueKey: active.opaqueKey,
          operationId: input.operationId,
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
    unwrap(
      await retryIdempotent(() =>
        home.activateSignup({
          operationId: input.operationId,
          opaqueKey: active.opaqueKey,
          now: input.now,
        }),
      ),
    );
  }

  async findPasswordCredential(
    email: string,
  ): Promise<PasswordCredential | null> {
    const canonical = canonicalPasswordCredential(email);
    const locators = await credentialLocators(canonical, this.keyring);
    for (const locator of locators) {
      const found = unwrap(
        await stub<DirectoryStub>(
          this.directory,
          directoryObjectName(locator),
        ).lookupPassword(locator.opaqueKey),
      );
      if (found) return found;
    }
    return null;
  }

  async getCurrentAccount(userId: string): Promise<CurrentAccount | null> {
    const account = unwrap(
      await stub<AccountHomeStub>(this.accountHomes, userId).current(),
    );
    if (!account) return null;
    const profile = unwrap(
      await stub<UserDataStub>(this.userData, userId).getProfile(),
    );
    if (profile.userId !== userId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "User Data owner does not match the authenticated account",
      );
    }
    return { ...account, trashRetentionDays: profile.trashRetentionDays };
  }
}
