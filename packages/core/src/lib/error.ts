/**
 * Cross-module-graph identity brand carried by every {@link CodedError}.
 *
 * `instanceof` cannot recognise these errors: SSR / RSC split the module graph,
 * so the same source file is instantiated more than once and each copy holds a
 * separate constructor. `Symbol.for` resolves through the realm-wide symbol
 * registry, so every copy of this module observes the same symbol and the
 * guards below keep answering correctly across graphs.
 *
 * Two limits bound what a brand check can claim, and `.adr/016` records them:
 * it does not survive `structuredClone`, `JSON` or the Worker ↔ Durable Object
 * RPC hop — past those the `SerializedError` envelope is the contract — and it
 * is reachable by anyone who can call `Symbol.for` with the same key, so it
 * answers "produced by our error classes", never "trustworthy". Never use it as
 * an authorization or input-validation step.
 *
 * Module-private on purpose: exporting it would publish a way to bypass
 * {@link isCodedError} / {@link hasSerializedKind}. Tests that need to build an
 * impostor re-derive it with `Symbol.for("@repo/core/CodedError")`.
 */
const CODED_ERROR_BRAND: unique symbol = Symbol.for("@repo/core/CodedError");

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
   * it is a compile error.
   *
   * The type derives from the subclass's own `toSerialized()` return type, but
   * only bites where that override narrows its return type to its own variant;
   * leave the return type off, or annotate it in this base's shape, and the
   * binding degrades to `string` and drift compiles. What actually catches the
   * drift is the per-suite `serializedKind === toSerialized().kind` test, whose
   * class list is hand-written — add an error class, add it there. See
   * `.adr/016`.
   */
  abstract readonly serializedKind: ReturnType<this["toSerialized"]>["kind"];

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
 *
 * Brand plus the four members production callers read off the narrowed value:
 * `toSerialized` / `serializedKind` are the contract itself, `code` / `message`
 * are what the per-kind guards hand on. Checking the contract on top of the
 * brand is what closes the accidental shapes — a forgery satisfying both stays
 * indistinguishable, which is the most a structural guard can do.
 *
 * Unchecked: `retryable`, and being an `Error`, with it `name` / `stack` /
 * `cause`. That residue rides on the brand. See `.adr/016`.
 */
export function isCodedError(value: unknown): value is CodedError {
  return (
    typeof value === "object" &&
    value !== null &&
    CODED_ERROR_BRAND in value &&
    typeof (value as { toSerialized?: unknown }).toSerialized === "function" &&
    typeof (value as { serializedKind?: unknown }).serializedKind ===
      "string" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Brand check plus discriminator match, the shape every per-kind guard is built
 * from. `kind` is compared against the concrete class's `serializedKind`, which
 * is intentionally many-to-one (`ValidationError` and the presentation layer's
 * `InputValidationError` both report `"validation"`), so a match narrows to the
 * contract, not to one class.
 *
 * Calling convention: call it from a layer's per-kind guard, and pass `kind` as
 * `Serialized*Error["kind"]` rather than a bare literal — `TKind extends string`
 * accepts any string, so a typo compiles into a guard that is always `false`.
 * The full set of kinds is assembled in the presentation layer, so `lib/` cannot
 * name it without inverting the dependency direction; the convention stands in
 * for that type, and the application layer's `kindGuard` factory enforces it.
 */
export function hasSerializedKind<TKind extends string>(
  value: unknown,
  kind: TKind,
): value is CodedError & { readonly serializedKind: TKind } {
  return isCodedError(value) && value.serializedKind === kind;
}
