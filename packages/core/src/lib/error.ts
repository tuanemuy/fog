/**
 * Cross-module-graph identity brand carried by every {@link CodedError}.
 *
 * `instanceof` cannot recognise these errors: SSR / RSC split the module graph,
 * so the same source file is instantiated more than once and each copy holds a
 * separate constructor. `Symbol.for` resolves through the realm-wide symbol
 * registry, so every copy of this module observes the same symbol and the
 * guards below keep answering correctly across graphs.
 *
 * Two limits are deliberate and must be understood before relying on it:
 *
 * - **Lifetime** — the brand is a symbol-keyed own property, so it does not
 *   survive `structuredClone`, `JSON` round-trips or the Worker ↔ Durable
 *   Object RPC hop. Past those boundaries the `SerializedError` envelope is
 *   the contract; a brand check there always answers `false`.
 * - **Trust** — the property is enumerable and writable, and the symbol is
 *   reachable by anyone who can call `Symbol.for` with the same key. A brand
 *   check answers "this was produced by our error classes", never "this value
 *   is trustworthy". Never use it as an authorization or input-validation step.
 */
export const CODED_ERROR_BRAND: unique symbol = Symbol.for(
  "@repo/core/CodedError",
);

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

  /**
   * Discriminator the guards match on, declared here so a subclass that forgets
   * it is a compile error. Bind it to the `kind` of the concrete
   * `toSerialized()` return type — e.g.
   * `readonly serializedKind: SerializedConflictError["kind"] = "conflict"` —
   * so the two cannot drift apart.
   */
  abstract readonly serializedKind: string;

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

/**
 * Structural counterpart of `error instanceof CodedError`. Answers only "this
 * came from the shared error contract" — use {@link hasSerializedKind} (or one
 * of the per-kind guards) when the concrete kind matters.
 */
export function isCodedError(value: unknown): value is CodedError {
  return (
    typeof value === "object" && value !== null && CODED_ERROR_BRAND in value
  );
}

/**
 * Brand check plus discriminator match, the shape every per-kind guard is built
 * from. `kind` is compared against the concrete class's `serializedKind`, which
 * is intentionally many-to-one (`ValidationError` and the presentation layer's
 * `InputValidationError` both report `"validation"`), so a match narrows to the
 * contract, not to one class.
 */
export function hasSerializedKind<TKind extends string>(
  value: unknown,
  kind: TKind,
): value is CodedError & { readonly serializedKind: TKind } {
  return isCodedError(value) && value.serializedKind === kind;
}
