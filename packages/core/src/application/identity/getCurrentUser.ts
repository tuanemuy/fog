import { UserId } from "@repo/core/domain/identity/valueObject";
import { NotFoundError, SystemError, SystemErrorCode } from "../errors";
import type { ServiceArgs } from "../types";
import type { CurrentUserView } from "./view";

export type GetCurrentUserInput = Readonly<{ userId: string }>;

/**
 * P-13 / P-03 display. The address is decrypted once, for its owner, from the
 * Identity Directory row the reverse index points at; the settings side holds
 * only the non-PII summary. An email credential that has no reverse-index row
 * or cannot be decrypted is drift, not a state.
 */
export async function getCurrentUser({
  container,
  input,
}: ServiceArgs<GetCurrentUserInput>): Promise<CurrentUserView> {
  const userId = UserId.create(input.userId);
  const gateway = container.identityGateway;

  const current = await gateway.readCurrentUser(userId);
  if (current === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }

  const emailCredential = current.credentials.find((c) => c.kind === "email");
  const emailLocator = emailCredential
    ? current.locators.find(
        (locator) => locator.credentialId === emailCredential.credentialId,
      )
    : undefined;
  if (emailCredential === undefined || emailLocator === undefined) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account holds no email credential",
    );
  }

  const email = await gateway.revealCanonical(
    {
      credentialId: emailLocator.credentialId,
      kind: "email",
      mapping: emailLocator.mapping,
    },
    userId,
  );
  if (email === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account's email address could not be read",
    );
  }

  return {
    userId: current.userId,
    email,
    credentials: current.credentials.map((c) => ({
      credentialId: c.credentialId,
      kind: c.kind,
      label: c.label,
      usableForLogin: c.usableForLogin,
    })),
    trashRetentionDays: current.trashRetentionDays,
  };
}
