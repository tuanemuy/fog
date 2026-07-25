import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { renderErrorMessage } from "@/presentation/errorDisplay";
import type { SerializedError } from "@/presentation/errorResponse";

/**
 * Decides where an authentication failure is shown.
 *
 * Errors that name a field go under that field, where the user can act on
 * them; everything else goes to the banner above the form. A duplicate
 * address additionally offers the login link, because "already
 * registered" is only useful paired with the way out.
 */

const EMAIL_ALREADY_REGISTERED = "EMAIL_ALREADY_REGISTERED";

const FIELD_BY_CODE: Readonly<Record<string, "email" | "password">> = {
  [IdentityErrorCode.InvalidEmail]: "email",
  [IdentityErrorCode.PasswordTooWeak]: "password",
  [EMAIL_ALREADY_REGISTERED]: "email",
};

export type AuthErrorDisplay = Readonly<{
  email: string | undefined;
  password: string | undefined;
  form: string | undefined;
  showLoginLink: boolean;
}>;

const NO_ERROR: AuthErrorDisplay = {
  email: undefined,
  password: undefined,
  form: undefined,
  showLoginLink: false,
};

export function toAuthErrorDisplay(
  error: SerializedError | null,
): AuthErrorDisplay {
  if (error === null) return NO_ERROR;

  // Transport-shape failures already say which field they are about.
  if (error.kind === "validation" && error.fieldErrors !== undefined) {
    const email = error.fieldErrors.email?.[0];
    const password = error.fieldErrors.password?.[0];
    if (email !== undefined || password !== undefined) {
      return { email, password, form: undefined, showLoginLink: false };
    }
  }

  const message = renderErrorMessage(error);
  const showLoginLink = error.code === EMAIL_ALREADY_REGISTERED;
  const field = error.code === null ? undefined : FIELD_BY_CODE[error.code];

  if (field === "email") {
    return {
      email: message,
      password: undefined,
      form: undefined,
      showLoginLink,
    };
  }
  if (field === "password") {
    return {
      email: undefined,
      password: message,
      form: undefined,
      showLoginLink,
    };
  }
  return {
    email: undefined,
    password: undefined,
    form: message,
    showLoginLink,
  };
}
