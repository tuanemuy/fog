import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import {
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { ServiceArgs } from "../types";
import { runCredentialChange } from "./credentialChangeSaga";
import { decayedFailedAttempts, lockoutWidthMs } from "./loginWithPassword";

export type ChangePasswordInput = Readonly<{
  userId: string;
  currentPassword: string;
  newPassword: string;
}>;

/**
 * S-AC-07 (logged in). The current password is checked against the same
 * counter as login; while attempts are limited the refusal is explicit
 * (`TOO_MANY_ATTEMPTS`), and a wrong current password is
 * `CURRENT_PASSWORD_MISMATCH` — an authenticated path has nothing to
 * hide. The change itself is the credential-change saga with
 * `origin: "password-change"`: the session epoch advances, the reset
 * version does not.
 */
export async function changePassword({
  container,
  input,
}: ServiceArgs<ChangePasswordInput>): Promise<void> {
  const now = container.clock.now();
  const tuning = container.identityTuning;
  const gateway = container.identityGateway;
  const currentPassword = PlainPassword.create(input.currentPassword);
  const newPassword = PlainPassword.create(input.newPassword);

  const user = await gateway.readCurrentUser(input.userId);
  if (user === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }
  const emailCredential = user.credentials.find(
    (c) => c.kind === "email" && c.usableForLogin,
  );
  if (emailCredential === undefined) {
    throw new BusinessRuleError(
      IdentityErrorCode.PasswordNotSupported,
      "This account has no password credential",
    );
  }
  const locator = await gateway.findCredentialLocator(
    input.userId,
    emailCredential.credentialId,
  );
  if (locator === null) {
    throw new NotFoundError(
      "CREDENTIAL_NOT_FOUND",
      "The credential was not found",
    );
  }
  const coordinate = {
    credentialId: locator.credentialId,
    kind: locator.kind,
    mapping: locator.mapping,
  };
  const record = await gateway.readCredentialForChange(coordinate);
  if (
    record === null ||
    record.userId !== input.userId ||
    record.passwordVerifier === null
  ) {
    throw new BusinessRuleError(
      IdentityErrorCode.PasswordNotSupported,
      "This account has no password credential",
    );
  }
  if (record.changeState !== null) {
    throw new ConflictError(
      "OPTIMISTIC_LOCK_FAILURE",
      "The credential is being changed by another operation",
    );
  }
  if (
    record.nextAttemptAllowedAt !== null &&
    record.nextAttemptAllowedAt.getTime() > now.getTime()
  ) {
    throw new ValidationError(
      "TOO_MANY_ATTEMPTS",
      "Attempts are limited for now; try again later",
    );
  }

  const matched = await container.passwordHasher.verify(
    currentPassword,
    PasswordHash.create(record.passwordVerifier),
  );
  if (!matched) {
    const failedAttempts =
      decayedFailedAttempts(
        record.failedAttempts,
        record.nextAttemptAllowedAt,
        now,
        tuning,
      ) + 1;
    await gateway.recordAttemptOutcome(coordinate, {
      outcome: "failure",
      observedFailedAttempts: record.failedAttempts,
      failedAttempts,
      nextAttemptAllowedAt: new Date(
        now.getTime() + lockoutWidthMs(failedAttempts, tuning),
      ),
    });
    throw new ValidationError(
      "CURRENT_PASSWORD_MISMATCH",
      "The current password is not correct",
    );
  }

  const pendingVerifier = await container.passwordHasher.hash(newPassword);
  await runCredentialChange(container, {
    coordinate,
    userId: input.userId,
    credentialId: emailCredential.credentialId,
    operationId: container.idGenerator.next(),
    pendingVerifier,
    origin: "password-change",
    changeAuthToken: null,
  });
}
