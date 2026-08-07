export const CODED_ERROR_BRAND: unique symbol = Symbol.for(
  "@repo/core/CodedError",
) as never;

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export type SerializedErrorBase = {
  code: string | null;
  message: string;
  retryable?: boolean;
};

export interface SerializableError {
  toSerialized(): SerializedErrorBase & { kind: string };
}

export function isSerializableError(
  value: unknown,
): value is SerializableError {
  return (
    typeof value === "object" &&
    value !== null &&
    "toSerialized" in value &&
    typeof (value as { toSerialized: unknown }).toSerialized === "function"
  );
}

export abstract class CodedError<TCode extends string = string> extends Error {
  override readonly name: string = "CodedError";
  readonly [CODED_ERROR_BRAND] = true as const;

  constructor(
    public readonly code: TCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
  }

  get retryable(): boolean {
    return false;
  }

  abstract toSerialized(): SerializedErrorBase & { kind: string };
}
