import { CodedError, type SerializedErrorBase } from "@repo/core/lib/error";
import { describe, expect, it } from "vitest";
import {
  BusinessRuleError,
  isBusinessRuleError,
  isRehydrationError,
  RehydrationError,
  type SerializedBusinessError,
} from "../error";

// Re-derived instead of imported: the brands are module-private, and going
// through the registry is exactly the lookup that makes them work across module
// graphs — a test that imported them would not exercise that.
const CODED_ERROR_BRAND = Symbol.for("@repo/core/CodedError");
const REHYDRATION_ERROR_BRAND = Symbol.for("@repo/core/RehydrationError");

// Mutual assignability rather than `extends`: a `toSerialized()` that widened
// back to `SerializedErrorBase & { kind: string }` still accepts the narrow type
// in one direction, so only the two-way check catches that regression.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A sibling `CodedError` defined here rather than imported from the application
// layer: the dependency direction is inward-only, so a domain test must not
// reach into `application/`.
class OtherCodedError extends CodedError {
  override readonly name = "OtherCodedError";
  readonly serializedKind = "other";

  override toSerialized(): SerializedErrorBase & { kind: "other" } {
    return {
      kind: this.serializedKind,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

// A `CodedError` that is not a `BusinessRuleError` yet reports the same
// `serializedKind` — the shape that makes `error is BusinessRuleError` unsound
// and the reason the guard's return type is structural.
class ForeignBusinessError extends CodedError {
  override readonly name = "ForeignBusinessError";
  readonly serializedKind = "business";

  override toSerialized(): SerializedErrorBase & { kind: "business" } {
    return {
      kind: this.serializedKind,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

const NON_ERROR_VALUES: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ['the string "boom"', "boom"],
  ["the number 0", 0],
  ["false", false],
  ["an empty object", {}],
  ["a plain Error", new Error("plain")],
];

// Answers every condition `isCodedError` checks for `kind: "business"` except
// the brand, so a guard rejecting it can only be rejecting it on the brand. The
// thinner objects the case below also passes are rejected for several reasons at
// once and therefore pin none of them individually.
function unbrandedBusinessContract(): Record<string, unknown> {
  return {
    serializedKind: "business",
    code: "TEST",
    message: "test",
    toSerialized: () => ({
      kind: "business",
      code: "TEST",
      message: "test",
      retryable: false,
    }),
  };
}

// The `?dup` query hands Vite a second instance of the same source file, which
// reproduces the SSR / RSC module-graph split that makes `instanceof` unusable.
async function loadForeignGraph(): Promise<typeof import("../error")> {
  const specifier = "../error.ts?dup";
  return import(/* @vite-ignore */ specifier);
}

describe("isBusinessRuleError", () => {
  it("returns true for a BusinessRuleError", () => {
    expect(isBusinessRuleError(new BusinessRuleError("TEST", "test"))).toBe(
      true,
    );
  });

  it("returns false for a branded sibling carrying another serializedKind", () => {
    expect(isBusinessRuleError(new OtherCodedError("TEST", "test"))).toBe(
      false,
    );
  });

  it("returns true for another CodedError reporting the same serializedKind", () => {
    const foreign: unknown = new ForeignBusinessError("TEST", "test");

    expect(isBusinessRuleError(foreign)).toBe(true);
    if (!isBusinessRuleError(foreign)) throw new Error("unreachable");
    // biome-ignore lint/plugin: negative control — the guard matched something that is not this class, which is why its return type is structural
    expect(foreign instanceof BusinessRuleError).toBe(false);

    // Unannotated on purpose: `narrowed` takes whatever type the guard's return
    // type gives the call, and the two pins below hold it to the variant.
    // Reading `.kind` alone cannot — it passes just as well against the wide
    // `SerializedErrorBase & { kind: string }` this guard degrades to if its
    // `Omit<CodedError, "toSerialized">` is written back as a plain
    // intersection. `Exact` is the two-way half, since the narrow type stays
    // assignable to the wide one.
    const narrowed = foreign.toSerialized();
    const exact: Exact<typeof narrowed, SerializedBusinessError> = true;
    const serialized: SerializedBusinessError = narrowed;

    expect(exact).toBe(true);
    expect(serialized.kind).toBe(
      new BusinessRuleError("TEST", "test").toSerialized().kind,
    );
  });

  it("returns false for an unbranded object whose serializedKind matches", () => {
    expect(isBusinessRuleError({ serializedKind: "business" })).toBe(false);
    expect(
      isBusinessRuleError({
        name: "BusinessRuleError",
        serializedKind: "business",
        code: "TEST",
        message: "test",
      }),
    ).toBe(false);
    expect(isBusinessRuleError(unbrandedBusinessContract())).toBe(false);
  });

  // Positive control for the case above: the same object plus the brand passes.
  // Without it, "unbranded" is not shown to be the reason that case answers
  // false — and the brand is what `Symbol.for` makes forgeable, so this also
  // documents the limit of the guard rather than a property to rely on.
  it("returns true for a branded forgery satisfying the whole contract", () => {
    expect(
      isBusinessRuleError({
        [CODED_ERROR_BRAND]: true,
        ...unbrandedBusinessContract(),
      }),
    ).toBe(true);
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(isBusinessRuleError(value)).toBe(false);
  });
});

describe("isRehydrationError", () => {
  it("returns true for a RehydrationError", () => {
    expect(isRehydrationError(new RehydrationError("test"))).toBe(true);
  });

  it("returns false for a BusinessRuleError", () => {
    expect(isRehydrationError(new BusinessRuleError("TEST", "test"))).toBe(
      false,
    );
  });

  it("returns false for an object that only carries the matching name", () => {
    expect(isRehydrationError({ name: "RehydrationError" })).toBe(false);

    const namedError = new Error("test");
    Object.defineProperty(namedError, "name", { value: "RehydrationError" });
    expect(isRehydrationError(namedError)).toBe(false);
  });

  // Its own brand, not the shared one: a `CodedError` must not answer true here.
  it("returns false for a value carrying only the CodedError brand", () => {
    expect(isRehydrationError({ [CODED_ERROR_BRAND]: true })).toBe(false);
  });

  // The brand is the whole of this guard, so this pins the registry key itself.
  // Nothing else does: a typo in `error.ts` leaves both module graphs agreeing
  // on the same wrong symbol, and the foreign-graph case stays green.
  it("returns true for a bare object carrying the brand", () => {
    expect(isRehydrationError({ [REHYDRATION_ERROR_BRAND]: true })).toBe(true);
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(isRehydrationError(value)).toBe(false);
  });
});

describe("serializedKind", () => {
  it("agrees with the kind that toSerialized emits", () => {
    const error = new BusinessRuleError("TEST", "test");
    expect(error.serializedKind).toBe(error.toSerialized().kind);
  });
});

describe("across a duplicated module graph", () => {
  it("matches a BusinessRuleError built in another module graph", async () => {
    const foreign = await loadForeignGraph();
    expect(foreign.BusinessRuleError).not.toBe(BusinessRuleError);

    const error = new foreign.BusinessRuleError("TEST", "test");

    // biome-ignore lint/plugin: negative control — this false is the failure mode the structural guards exist to replace
    expect(error instanceof BusinessRuleError).toBe(false);
    expect(isBusinessRuleError(error)).toBe(true);
    expect(isRehydrationError(error)).toBe(false);
  });

  it("matches a RehydrationError built in another module graph", async () => {
    const foreign = await loadForeignGraph();
    expect(foreign.RehydrationError).not.toBe(RehydrationError);

    // The dup'd module runs its own `Symbol.for("@repo/core/RehydrationError")`;
    // the registry is what makes the two brands the same symbol.
    const error = new foreign.RehydrationError("test");

    // biome-ignore lint/plugin: negative control — this false is the failure mode the structural guards exist to replace
    expect(error instanceof RehydrationError).toBe(false);
    expect(isRehydrationError(error)).toBe(true);
    expect(isBusinessRuleError(error)).toBe(false);
  });
});
