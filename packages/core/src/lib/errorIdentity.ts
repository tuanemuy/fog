import { CodedError } from "./error";

/**
 * An error's *identity* — `Name:CODE`, or just `Name` — and never its message.
 *
 * A leaf module on purpose: the same projection is needed by the job runner
 * (`terminal_reason` and its log line) and by each Durable Object class's
 * `alarm()` catch, and those two must not be able to drift apart.
 *
 * The rule it enforces: an arbitrary error string can carry a canonical
 * address, an hmac, a locator, a caller token or a reset token, and both
 * `terminal_reason` and the log stream outlive the request and leave the
 * Durable Object's trust boundary. Names and codes are authored in this
 * repository; messages are not, once a driver or a platform failure is in the
 * mix.
 */
export function errorIdentity(error: unknown): string {
  if (error instanceof CodedError) {
    return `${error.name}:${error.code}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "UnknownError";
}
