import type { SerializedRpcError } from "@repo/core/application/delivery/types";
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
import type { CodedError } from "@repo/core/lib/error";

/**
 * Rebuilds an error that crossed the Durable Object boundary as a value
 * envelope back into the shared error contract.
 *
 * The envelope is needed because RPC does not preserve the structural
 * serialization contract — a thrown custom class arrives on the other
 * side as a plain object with none of the brands the guards match on. The
 * DO's entry serializes; this rebuilds, and from here on the value
 * behaves like any other error of its kind, including at the HTTP status
 * mapping in the presentation layer.
 *
 * **The value being rebuilt is never re-thrown as it stands.** It arrived
 * over the wire, and the server-side classification of thrown values
 * rests on no thrown value's shape deriving from external input; an
 * unrecognised `kind` therefore becomes a `SystemError` rather than
 * travelling further in its original shape.
 *
 * `serializedKind` is many-to-one by design, so this maps a contract to a
 * representative class, not back to the exact class that was thrown.
 *
 * **Both fallbacks land on `UnclassifiedError`, never on
 * `DatabaseError`.** An unrecognised `kind` and a `code` outside
 * `SystemErrorCode` both say the DO answered in a shape this build does
 * not know, which is not a storage fault; `DatabaseError` is the code
 * `callDurableObject` raises when the DO was never reached, and keeping
 * the two apart is what lets a log say which of the two happened.
 */
export function rebuildRpcError(serialized: SerializedRpcError): CodedError {
  const code = serialized.code ?? "UNKNOWN";
  const message = serialized.message;
  switch (serialized.kind) {
    case "notFound":
      return new NotFoundError(code, message);
    case "conflict":
      return new ConflictError(code, message);
    case "validation":
      return new ValidationError(code, message);
    case "unauthorized":
      return new UnauthorizedError(code, message);
    case "forbidden":
      return new ForbiddenError(code, message);
    case "business":
      return new BusinessRuleError(code, message);
    case "system":
      return new SystemError(asSystemErrorCode(code), message);
    default:
      return new SystemError(
        SystemErrorCode.UnclassifiedError,
        `Durable Object returned an unrecognised error kind: ${serialized.kind}`,
      );
  }
}

function asSystemErrorCode(code: string): SystemErrorCode {
  const known = Object.values(SystemErrorCode) as string[];
  return known.includes(code)
    ? (code as SystemErrorCode)
    : SystemErrorCode.UnclassifiedError;
}
