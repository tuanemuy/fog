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
 * - **Membership** — the guards here (and the application / domain guards
 *   built the same way) test the brand with `in`, which walks the prototype
 *   chain; real instances pass either idiom, since a class field is an own
 *   property, and narrowing to `Object.hasOwn` would close nothing — a forgery
 *   that plants the brand on a prototype still has to carry the full checked
 *   contract (`toSerialized` / `serializedKind` / `code` / `message`) to pass.
 *   The presentation layer's `isAppServerError` uses `Object.hasOwn` instead,
 *   for consistency with its `isSerializedErrorKind` lookup — an idiom
 *   difference, not a soundness one.
 *
 * Module-private on purpose: exporting it would publish a way to bypass
 * {@link isCodedError} / {@link hasSerializedKind} and would sit oddly next to
 * the forgeability warning above. Tests that need to build an impostor
 * re-derive it with `Symbol.for("@repo/core/CodedError")`, which exercises the
 * registry lookup that makes the brand work in the first place.
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
   * The type is derived from the subclass's own `toSerialized()` return type,
   * so a value that disagrees with the `kind` that method emits does not
   * compile (TS2416) — with or without an explicit annotation here.
   * Annotating it as `readonly serializedKind: SerializedConflictError["kind"]`
   * is therefore optional, and documents intent rather than enforcing it.
   *
   * That derivation only bites where the subclass narrows its `toSerialized()`
   * return type to its own variant: leave the return type off, or annotate it
   * in this base's shape, and the constraint degrades to `string` and drift
   * compiles. The effective net is the per-suite agreement tests asserting
   * `serializedKind === toSerialized().kind` — each suite (lib / domain /
   * application / presentation) enumerates its concrete classes by hand, so a
   * new subclass left out of its suite's enumeration is not detected.
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
 * The brand alone cannot make this predicate sound: anyone can call
 * `Symbol.for` with the same key, so a forged value will always be able to
 * satisfy it. Checking the contract on top closes the accidental shapes — a
 * value that happens to carry the brand but cannot answer it — which is the
 * most a structural guard can do here.
 *
 * The four checked members are the ones production callers read off the
 * narrowed value: `toSerialized` and `serializedKind` are the contract itself,
 * and `code` / `message` are what the per-kind guards, which are this check plus
 * a discriminator comparison, hand on. What stays unchecked is the rest of
 * `CodedError`'s promise — `retryable`, and being an `Error`, with it `name`,
 * `stack` and `cause`. `retryable` goes unchecked despite being `CodedError`'s
 * own getter rather than an `Error` member: it is readable off the narrowed
 * value and answers `undefined` on a forgery, but nothing reads it there — each
 * class settles it inside its own `toSerialized()` instead. That
 * residue rides on the brand rather than on a test of its own; weakening the
 * predicate to a structural type would not remove it, only push it into the
 * per-kind guards, which assert the same class-shaped contract off this very
 * function.
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
 * `Serialized*Error["kind"]` rather than a bare literal. `TKind extends string`
 * accepts any string, so a typo compiles into a guard that is always `false`.
 * The full set of kinds is assembled in the presentation layer, so `lib/` — on
 * which every layer depends — cannot name it without inverting the dependency
 * direction; the convention is what stands in for that type.
 */
export function hasSerializedKind<TKind extends string>(
  value: unknown,
  kind: TKind,
): value is CodedError & { readonly serializedKind: TKind } {
  return isCodedError(value) && value.serializedKind === kind;
}
