import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

// Transport shape only (DoS bounds). The business rules — canonical email,
// 8–128 character password — belong to the value objects.
export const credentialsSchema = z.object({
  email: z.string().max(1024),
  password: z.string().max(1024),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.string().max(1024),
});

export const executePasswordResetSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().max(1024),
});

/** `?sso_error=` values the bare SSO handlers redirect with (△-6). */
export const ssoErrorSchema = z.enum([
  "email_registered",
  "already_used",
  "unverified",
  "failed",
]);
export type SsoErrorCode = z.infer<typeof ssoErrorSchema>;

/** What `requestPasswordResetFn` resolves to; the same for every address. */
export type ResetRequestedResult = Readonly<{ ok: true }>;
export function isResetRequestedResult(
  value: unknown,
): value is ResetRequestedResult {
  return isRecord(value) && value.ok === true;
}

/** What `registerFn` / `loginFn` resolve to, checked at the client boundary. */
export type SessionStartedResult = Readonly<{ userId: string }>;

export function isSessionStartedResult(
  value: unknown,
): value is SessionStartedResult {
  return isRecord(value) && isNonEmptyString(value.userId);
}

/** What `logoutFn` resolves to, checked at the client boundary. */
export type SessionEndedResult = Readonly<{ ok: true }>;

export function isSessionEndedResult(
  value: unknown,
): value is SessionEndedResult {
  return isRecord(value) && value.ok === true;
}
