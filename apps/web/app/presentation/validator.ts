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
 * only from another transport-boundary validator.
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

function zodIssuesToFieldErrors(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): FieldErrors {
  const acc: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map((segment) => String(segment)).join(".");
    const bucket = acc[key] ?? [];
    bucket.push(issue.message);
    acc[key] = bucket;
  }
  return acc;
}
