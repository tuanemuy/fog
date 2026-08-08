import { CodedError, type FieldErrors } from "@repo/core/lib/error";
import type { ZodType, z } from "zod";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

/**
 * The transport boundary's shape failure, serialized as `kind: "validation"`.
 *
 * Exported because it is one of the layer's error types, not an implementation
 * detail of {@link validateInput}: it is the second producer of the `validation`
 * kind alongside the application layer's `ValidationError`, which is why
 * `serializedKind` is many-to-one. It is not an `ApplicationError`.
 *
 * `validateInput` is the only producer here and does not throw this class
 * as-is — it wraps `toSerialized()` in an `AppServerError` so
 * `appServerErrorAdapter` recognises it on the way out. A bare throw is
 * equivalent only behind `errorResponseMiddleware`; past a boundary without it
 * the payload is dropped and the client reads `kind: "unknown"`.
 */
export class InputValidationError extends CodedError {
  override readonly name = "InputValidationError";
  readonly serializedKind: SerializedValidationError["kind"] = "validation";

  constructor(public readonly fieldErrors: FieldErrors) {
    super("INVALID_INPUT", "Invalid input");
  }

  override toSerialized(): SerializedValidationError {
    return {
      kind: "validation",
      code: this.code,
      message: this.message,
      retryable: false,
      fieldErrors: this.fieldErrors,
    };
  }
}

// Structural / DoS guard at the transport boundary. Business invariants live in
// value-object factories — keeping Zod out of application/domain also keeps
// this safe to run inside the client bundle `inputValidator` enters.
export function validateInput<T extends ZodType>(schema: T) {
  return (input: unknown): z.infer<T> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const error = new InputValidationError(
      zodIssuesToFieldErrors(parsed.error.issues),
    );
    throw new AppServerError(error.toSerialized());
  };
}

// Accumulates in a Map so a path key colliding with `Object.prototype`
// (`"constructor"`, `"toString"`, …) reads back an own bucket — a plain-object
// accumulator would return the inherited member and die on `bucket.push`.
// `"__proto__"` is dropped rather than emitted, because `rebuildFieldErrors`
// rejects any payload carrying it and would degrade the whole 422 to `unknown`;
// the cost is that one path's message, leaving `INVALID_INPUT` to speak for it.
// Both are reachable only through a schema that writes `issue.path` itself
// (`superRefine`, or `z.record` over a parsed body), not through today's
// fixed-key `z.object` schemas.
function zodIssuesToFieldErrors(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): FieldErrors {
  const acc = new Map<string, string[]>();
  for (const issue of issues) {
    const key = issue.path.map((segment) => String(segment)).join(".");
    if (key === "__proto__") continue;
    const bucket = acc.get(key) ?? [];
    bucket.push(issue.message);
    acc.set(key, bucket);
  }
  return Object.fromEntries(acc);
}
