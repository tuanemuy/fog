import {
  Email,
  PlainPassword,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { ConflictError } from "../errors";
import type { ServiceArgs } from "../types";
import { operationId } from "./contracts";

export type RegisterWithPasswordInput = {
  operationId: string;
  email: string;
  password: string;
};

export type RegisterWithPasswordOutput = {
  userId: string;
  sessionEpoch: number;
};

function emailAlreadyRegistered(cause?: unknown): ConflictError {
  return new ConflictError(
    "EMAIL_ALREADY_REGISTERED",
    "That email address is already registered",
    cause,
  );
}

/**
 * Registers a password account.
 *
 * An already-registered address is rejected outright rather than linked
 * to the existing account, whatever its auth method — silently merging
 * identities is how account-takeover bugs start.
 *
 * The hash is computed before the unit of work opens: key derivation is
 * deliberately slow, and holding a transaction across it would pin a
 * connection for the duration.
 */
export async function registerWithPassword({
  container,
  input,
}: ServiceArgs<RegisterWithPasswordInput>): Promise<RegisterWithPasswordOutput> {
  const now = container.clock.now();
  const stableOperationId = operationId(input.operationId);
  const proposedUserId = UserId.create(container.idGenerator.next());
  const email = Email.create(input.email);
  const plainPassword = PlainPassword.create(input.password);

  const passwordHash = await container.passwordHasher.hash(plainPassword);

  try {
    if (!container.identity)
      throw new Error("Identity gateway is not configured");
    const prepared = await container.identity.preparePasswordSignup({
      operationId: stableOperationId,
      proposedUserId,
      email,
      passwordHash,
      now: now.getTime(),
    });
    if (
      prepared.replayed &&
      !(await container.passwordHasher.verify(
        plainPassword,
        prepared.passwordHash,
      ))
    ) {
      throw new ConflictError(
        "IDENTITY_OPERATION_PAYLOAD_CONFLICT",
        "Signup operation does not match its original password",
      );
    }
    const result = await container.identity.registerWithPassword({
      operationId: stableOperationId,
      userId: prepared.userId,
      email,
      passwordHash: prepared.passwordHash,
      now: prepared.preparedAt,
    });
    return { userId: prepared.userId, sessionEpoch: result.sessionEpoch };
  } catch (error) {
    if (
      error instanceof ConflictError &&
      error.code === "CREDENTIAL_ALREADY_REGISTERED"
    ) {
      throw emailAlreadyRegistered(error);
    }
    throw error;
  }
}
