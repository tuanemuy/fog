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
  const id = UserId.create(stableOperationId);
  const email = Email.create(input.email);
  const plainPassword = PlainPassword.create(input.password);

  const passwordHash = await container.passwordHasher.hash(plainPassword);

  try {
    if (!container.identity)
      throw new Error("Identity gateway is not configured");
    const result = await container.identity.registerWithPassword({
      operationId: stableOperationId,
      userId: id,
      email,
      passwordHash,
      now: now.getTime(),
    });
    return { userId: id, sessionEpoch: result.sessionEpoch };
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
