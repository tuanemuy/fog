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
 * detail of {@link validateInput}: it is the second producer of the
 * `validation` kind alongside the application layer's `ValidationError`, and
 * `packages/core/src/lib/error.ts` names it as the reason `serializedKind` is
 * many-to-one. It is not an `ApplicationError` — the guards it answers to are
 * `isCodedError` / `isValidationError`, never `isApplicationError`.
 *
 * `validateInput` is the only producer in this repository; throw it directly
 * only from another transport-boundary validator. Note that `validateInput`
 * does not throw this class as-is — it wraps `toSerialized()` in an
 * `AppServerError` so `appServerErrorAdapter` recognises it on the way out. A
 * bare throw is only equivalent behind a boundary carrying
 * `errorResponseMiddleware`, which re-serializes it structurally; past a
 * boundary without that middleware the payload is dropped and the client reads
 * `kind: "unknown"`.
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

// Accumulates in a Map so a path key that collides with `Object.prototype`
// (`"constructor"`, `"toString"`, …) reads back an own bucket, never an
// inherited value — a plain-object accumulator would return `Object.prototype`
// members for those keys and die on `bucket.push`. Unreachable through the
// current fixed-key `z.object` schemas; a `z.record` / `catchAll` schema over a
// `JSON.parse`d body is what would get here. The exact key `"__proto__"` is
// dropped instead of emitted: `rebuildFieldErrors` on the consuming side
// rejects any payload carrying it as an own key, so emitting it would degrade
// the whole 422 to `unknown` — the cost is that this one path's message is
// lost, leaving the generic `INVALID_INPUT` to speak for it. Zod's own parsers
// never put a bare `__proto__` on `issue.path` (its record/object traversal
// skips that input key), so the drop is reachable only through a schema that
// writes the path itself, e.g. `superRefine`.
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
