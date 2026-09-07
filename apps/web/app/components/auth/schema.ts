import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

// Transport shape only (DoS bounds). The business rules — canonical email,
// 8–128 character password — belong to the value objects.
export const credentialsSchema = z.object({
  email: z.string().max(1024),
  password: z.string().max(1024),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;

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
