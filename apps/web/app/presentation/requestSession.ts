import type { RequestContainer } from "@repo/core/application/di/types";
import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { SESSION_COOKIE_NAME } from "./sessionCookie";

/** One cookie's value off a raw request; `null` when absent or undecodable. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The session check of `presentation/currentUser.ts`, on a raw `Request`
 * — for the handlers that run before TanStack (SSO, export). Same
 * verdicts, same silence about which check failed: signature, expiry,
 * the account's state, its `sessionEpoch`, and an object that was never
 * initialised all come back as `null`.
 */
export async function readSessionUserId(
  request: Request,
  container: RequestContainer,
): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token === null) return null;
  const verified = await container.sessionCodec.verify(
    token,
    container.clock.now(),
  );
  if (verified === null) return null;
  let account: Awaited<
    ReturnType<typeof container.identityGateway.readAccountState>
  >;
  try {
    account = await container.identityGateway.readAccountState(verified.userId);
  } catch (error) {
    if (isSystemError(error) && error.code === SystemErrorCode.NotInitialized) {
      return null;
    }
    throw error;
  }
  if (account === null || account.status !== "active") return null;
  if (account.sessionEpoch > verified.sessionEpoch) return null;
  return verified.userId;
}
