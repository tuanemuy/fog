import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { PlainPassword } from "@repo/core/domain/identity/valueObject";
import { ValidationError } from "../errors";
import type { ServiceArgs } from "../types";
import { runCredentialChange } from "./credentialChangeSaga";

export type ExecutePasswordResetInput = Readonly<{
  token: string;
  newPassword: string;
}>;

export type ExecutePasswordResetOutput = Readonly<{ userId: string }>;

/**
 * S-AC-07, completion. The new password is checked against its rule
 * before the token is consumed, so a weak password does not spend the
 * link; then the credential-change saga runs with `origin: "reset"`,
 * which advances the reset version and revokes the connections created
 * since the previous completion. The presentation starts the new session
 * from the returned id — after the epoch advanced, so only that session
 * lives.
 */
export async function executePasswordReset({
  container,
  input,
}: ServiceArgs<ExecutePasswordResetInput>): Promise<ExecutePasswordResetOutput> {
  const newPassword = PlainPassword.create(input.newPassword);
  const consumed = await container.identityGateway.consumeResetToken(
    input.token,
  );
  if (consumed === null) {
    throw new ValidationError(
      "RESET_TOKEN_INVALID",
      "The reset link is invalid or has expired",
    );
  }
  if (!consumed.hasVerifier) {
    throw new BusinessRuleError(
      IdentityErrorCode.PasswordNotSupported,
      "This credential has no password to reset",
    );
  }
  const pendingVerifier = await container.passwordHasher.hash(newPassword);
  await runCredentialChange(container, {
    coordinate: consumed.coordinate,
    userId: consumed.userId,
    credentialId: consumed.credentialId,
    operationId: container.idGenerator.next(),
    pendingVerifier,
    origin: "reset",
    changeAuthToken: consumed.changeAuthToken,
  });
  return { userId: consumed.userId };
}
