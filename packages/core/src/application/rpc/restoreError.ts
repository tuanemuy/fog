import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  UnauthorizedError,
  ValidationError,
} from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import type {
  RpcEnvelope,
  SerializedErrorPayload,
} from "@repo/core/lib/rpcEnvelope";

/**
 * Rebuilds a thrown error from the serialized form the Durable Object returned
 * in its value envelope. RPC does not preserve custom classes, so the calling
 * adapter unwraps here and the rest of the request Worker sees the same error
 * classes it would have seen from an in-process call.
 *
 * The table is closed over the two modules that own error classes in
 * `packages/core`: `application/errors.ts` and `domain/error.ts`. Presentation's
 * `unknown` variant is absent on purpose — no envelope ever carries it (see
 * `adapters/cloudflare/platform/envelope.ts`), and `errorResponse.test.ts`
 * pins the two key sets against each other from the presentation side, where
 * the union's authority lives.
 */

type Restorer = (payload: SerializedErrorPayload) => Error;

const RESTORERS = {
  business: (p) => new BusinessRuleError<string>(p.code ?? "", p.message),
  notFound: (p) => new NotFoundError(p.code ?? "", p.message),
  conflict: (p) => new ConflictError(p.code ?? "", p.message),
  unauthorized: (p) => new UnauthorizedError(p.code ?? "", p.message),
  forbidden: (p) => new ForbiddenError(p.code ?? "", p.message),
  validation: (p) => new ValidationError(p.code ?? "", p.message),
  system: (p) => new SystemError(asSystemErrorCode(p.code), p.message),
} as const satisfies Readonly<Record<string, Restorer>>;

export const RESTORABLE_ERROR_KINDS = Object.keys(RESTORERS);

const SYSTEM_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(SystemErrorCode),
);

function asSystemErrorCode(code: string | null): SystemErrorCode {
  return code !== null && SYSTEM_ERROR_CODES.has(code)
    ? (code as SystemErrorCode)
    : SystemErrorCode.DatabaseError;
}

export function restoreError(payload: SerializedErrorPayload): Error {
  const restore: Restorer | undefined = (
    RESTORERS as Readonly<Record<string, Restorer>>
  )[payload.kind];
  if (restore === undefined) {
    // Never collapse an unrecognised kind into a generic error silently:
    // adding a serialized variant and forgetting this table is precisely the
    // failure this branch exists to make loud.
    return new SystemError(
      SystemErrorCode.DataIntegrityError,
      `Unknown serialized error kind from RPC: ${payload.kind}`,
    );
  }
  return restore(payload);
}

export function unwrap<T>(envelope: RpcEnvelope<T>): T {
  if (envelope.ok) {
    return envelope.value;
  }
  throw restoreError(envelope.error);
}
