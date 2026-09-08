import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

/** The signed authorization request P-14 carries (transport bound only). */
export const authorizationRequestSchema = z.object({
  request: z.string().min(1).max(4096),
});

export type AuthorizationRequestView =
  | Readonly<{ ok: true; clientName: string; email: string }>
  | Readonly<{ ok: false }>;

export function isAuthorizationRequestView(
  value: unknown,
): value is AuthorizationRequestView {
  if (!isRecord(value)) return false;
  if (value.ok === false) return true;
  return (
    value.ok === true &&
    isNonEmptyString(value.clientName) &&
    typeof value.email === "string"
  );
}

/** Where the browser goes next: the client's own redirect URI, code or error attached. */
export type AuthorizationOutcome = Readonly<{ redirectTo: string }>;

export function isAuthorizationOutcome(
  value: unknown,
): value is AuthorizationOutcome {
  return isRecord(value) && isNonEmptyString(value.redirectTo);
}
