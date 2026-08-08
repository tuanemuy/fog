import {
  BusinessRuleError,
  isBusinessRuleError,
  type SerializedBusinessError,
} from "@repo/core/domain/error";
import {
  CodedError,
  isCodedError,
  type SerializedErrorBase,
} from "@repo/core/lib/error";
import { describe, expect, it } from "vitest";
import * as errors from "../errors";
// Named as well as namespaced: the GritQL ban matches the identifier as
// written, so only these bindings put the negative controls below under lint.
import {
  ApplicationError,
  ConflictError,
  type SerializedConflictError,
  type SerializedForbiddenError,
  type SerializedNotFoundError,
  type SerializedSystemError,
  type SerializedUnauthorizedError,
  type SerializedValidationError,
} from "../errors";

type ErrorsModule = typeof errors;

// Re-derived instead of imported: the brand is module-private, and going
// through the registry is exactly the lookup that makes it work across module
// graphs — a test that imported it would not exercise that.
const CODED_ERROR_BRAND = Symbol.for("@repo/core/CodedError");
const APPLICATION_ERROR_BRAND = Symbol.for("@repo/core/ApplicationError");

// Mutual assignability rather than `extends`: a `toSerialized()` that widened
// back to `SerializedErrorBase & { kind: string }` still accepts the narrow type
// in one direction, so only the two-way check catches that regression.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type GuardCase = {
  readonly kind: string;
  readonly guard: (value: unknown) => boolean;
  readonly build: (module: ErrorsModule) => CodedError;
};

// Every guard the module exports that discriminates on `serializedKind`, each
// paired with a builder taking the module it should be constructed from — the
// same table then drives the local matrix and the foreign-graph run.
const APPLICATION_CASES: readonly GuardCase[] = [
  {
    kind: "notFound",
    guard: errors.isNotFoundError,
    build: (m) => new m.NotFoundError("TEST", "test"),
  },
  {
    kind: "conflict",
    guard: errors.isConflictError,
    build: (m) => new m.ConflictError("TEST", "test"),
  },
  {
    kind: "validation",
    guard: errors.isValidationError,
    build: (m) => new m.ValidationError("TEST", "test"),
  },
  {
    kind: "unauthorized",
    guard: errors.isUnauthorizedError,
    build: (m) => new m.UnauthorizedError("TEST", "test"),
  },
  {
    kind: "forbidden",
    guard: errors.isForbiddenError,
    build: (m) => new m.ForbiddenError("TEST", "test"),
  },
  {
    kind: "system",
    guard: errors.isSystemError,
    build: (m) => new m.SystemError(m.SystemErrorCode.DatabaseError, "test"),
  },
];

const ALL_CASES: readonly GuardCase[] = [
  ...APPLICATION_CASES,
  {
    kind: "business",
    guard: isBusinessRuleError,
    build: () => new BusinessRuleError("TEST", "test"),
  },
];

const NON_ERROR_VALUES: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ['the string "boom"', "boom"],
  ["the number 0", 0],
  ["false", false],
  ["an empty object", {}],
  ["a plain Error", new Error("plain")],
];

// A `CodedError` that belongs to no layer: it carries the shared brand but not
// the `ApplicationError` one.
class LayerlessCodedError extends CodedError {
  override readonly name = "LayerlessCodedError";
  readonly serializedKind = "layerless";

  override toSerialized(): SerializedErrorBase & { kind: "layerless" } {
    return {
      kind: this.serializedKind,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

// Answers every condition `isCodedError` checks for the given kind except the
// brand, so a guard rejecting it can only be rejecting it on the brand. The
// bare `{ serializedKind }` object the matrix also passes is rejected for four
// other reasons at once and therefore pins none of them.
function unbrandedContract(kind: string): Record<string, unknown> {
  return {
    serializedKind: kind,
    code: "TEST",
    message: "test",
    toSerialized: () => ({
      kind,
      code: "TEST",
      message: "test",
      retryable: false,
    }),
  };
}

function brandedContract(kind: string): unknown {
  return { [CODED_ERROR_BRAND]: true, ...unbrandedContract(kind) };
}

// The complete forgery `isApplicationError` accepts: the whole `CodedError`
// contract, its brand, and the layer brand on top. The negative cases each
// drop exactly one of those pieces off this shape.
function applicationForgery(kind: string): unknown {
  return {
    [APPLICATION_ERROR_BRAND]: true,
    [CODED_ERROR_BRAND]: true,
    ...unbrandedContract(kind),
  };
}

// The `?dup` query hands Vite a second instance of the same source file, which
// reproduces the SSR / RSC module-graph split that makes `instanceof` unusable.
async function loadForeignGraph(): Promise<ErrorsModule> {
  const specifier = "../errors.ts?dup";
  return import(/* @vite-ignore */ specifier);
}

async function loadForeignDomainGraph(): Promise<
  typeof import("@repo/core/domain/error")
> {
  const specifier = "../../domain/error.ts?dup";
  return import(/* @vite-ignore */ specifier);
}

describe("kind discrimination matrix", () => {
  describe.each(ALL_CASES)("the $kind guard", (subject) => {
    it.each(ALL_CASES)("answers a $kind error correctly", (candidate) => {
      const error = candidate.build(errors);
      expect(subject.guard(error)).toBe(subject.kind === candidate.kind);
    });

    it.each(ALL_CASES)(
      "rejects an unbranded object whose serializedKind is $kind",
      (candidate) => {
        expect(subject.guard({ serializedKind: candidate.kind })).toBe(false);
        expect(subject.guard(unbrandedContract(candidate.kind))).toBe(false);
      },
    );

    // Positive control for the row above: the same object plus the brand is
    // accepted by the guard whose kind it claims. Without it, "unbranded" is not
    // shown to be the reason the row above answers false.
    it.each(ALL_CASES)(
      "answers a branded forgery claiming $kind the same way it answers the class",
      (candidate) => {
        expect(subject.guard(brandedContract(candidate.kind))).toBe(
          subject.kind === candidate.kind,
        );
      },
    );

    it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
      expect(subject.guard(value)).toBe(false);
    });
  });
});

// `NarrowedByKind` (and `isBusinessRuleError`'s hand-written counterpart)
// stand on the premise that every `Serialized*Error` adds nothing but optional
// properties to `SerializedErrorBase & { kind }` — the runtime checks only
// `serializedKind === kind`, so a variant growing a required field would make
// the narrowed `toSerialized(): TSerialized` a silent lie. These `satisfies`
// clauses are the compile-time pin: the base contract plus `kind` alone must
// stay assignable to each variant, so adding a required field is a type error
// here before it becomes an unsound narrowing there.
describe("every Serialized*Error variant adds only optional fields", () => {
  it("accepts the base contract plus kind alone for each variant", () => {
    const minimal: SerializedErrorBase = { code: null, message: "" };
    const pinned = [
      { ...minimal, kind: "notFound" } satisfies SerializedNotFoundError,
      { ...minimal, kind: "validation" } satisfies SerializedValidationError,
      { ...minimal, kind: "conflict" } satisfies SerializedConflictError,
      {
        ...minimal,
        kind: "unauthorized",
      } satisfies SerializedUnauthorizedError,
      { ...minimal, kind: "forbidden" } satisfies SerializedForbiddenError,
      { ...minimal, kind: "system" } satisfies SerializedSystemError,
      { ...minimal, kind: "business" } satisfies SerializedBusinessError,
    ];
    expect(pinned).toHaveLength(ALL_CASES.length);
  });
});

describe("serializedKind", () => {
  it.each(ALL_CASES)(
    "agrees with toSerialized().kind for $kind",
    (testCase) => {
      const error = testCase.build(errors);
      expect(error.serializedKind).toBe(error.toSerialized().kind);
      expect(error.serializedKind).toBe(testCase.kind);
    },
  );
});

// A `CodedError` from no layer of ours that nonetheless reports `"conflict"` —
// the shape that makes `error is ConflictError` unsound for any kind, not just
// the two-producer `validation`.
class ForeignConflictError extends CodedError {
  override readonly name = "ForeignConflictError";
  readonly serializedKind = "conflict";

  override toSerialized(): SerializedErrorBase & { kind: "conflict" } {
    return {
      kind: this.serializedKind,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

describe("per-kind guards narrow to the contract, not the class", () => {
  it("matches any CodedError reporting the kind", () => {
    const foreign = new ForeignConflictError("TEST", "test");

    expect(errors.isConflictError(foreign)).toBe(true);
    expect(errors.isApplicationError(foreign)).toBe(false);
    // biome-ignore lint/plugin: negative control — the guard above matched something that is not this class, which is the point
    expect(foreign instanceof ConflictError).toBe(false);
  });

  it("exposes the serialized payload through the narrowed type", () => {
    const foreign: unknown = new ForeignConflictError("TEST", "test");

    if (!errors.isConflictError(foreign)) throw new Error("unreachable");

    // Unannotated on purpose: `narrowed` takes whatever type the guard's return
    // type gives the call, and the two pins below hold it to the variant.
    // `toEqual` alone cannot — it passes just as well against the wide
    // `SerializedErrorBase & { kind: string }` that `NarrowedByKind` degrades to
    // if its `Omit<CodedError, "toSerialized">` is written back as a plain
    // intersection. `Exact` is the two-way half, since the narrow type stays
    // assignable to the wide one.
    const narrowed = foreign.toSerialized();
    const exact: Exact<typeof narrowed, SerializedConflictError> = true;
    const serialized: SerializedConflictError = narrowed;

    expect(exact).toBe(true);
    expect(serialized).toEqual({
      kind: "conflict",
      code: "TEST",
      message: "test",
      retryable: false,
    });
  });

  // `fieldErrors` exists on no other variant, so referencing it is what shows
  // the narrowing reaches the variant's own shape and not just its `kind`.
  it("exposes a variant-only field through the narrowed type", () => {
    const error: unknown = new errors.ValidationError("TEST", "test", {
      email: ["required"],
    });

    if (!errors.isValidationError(error)) throw new Error("unreachable");

    const narrowed = error.toSerialized();
    const exact: Exact<typeof narrowed, SerializedValidationError> = true;
    const serialized: SerializedValidationError = narrowed;

    expect(exact).toBe(true);
    expect(serialized.fieldErrors).toEqual({ email: ["required"] });
    expect(error.toSerialized().fieldErrors).toEqual({ email: ["required"] });
  });
});

describe("isApplicationError", () => {
  it.each(APPLICATION_CASES)("returns true for a $kind error", (testCase) => {
    expect(errors.isApplicationError(testCase.build(errors))).toBe(true);
  });

  // No production caller today — `mapDbError`, which used to be the one, asks
  // `isCodedError` instead. The predicate stays published because it answers a
  // different question (which *layer* raised this), so what these cases pin is
  // exactly that difference: a `BusinessRuleError` is a `CodedError` and not an
  // `ApplicationError`.
  it("returns false for a BusinessRuleError, which isCodedError still accepts", () => {
    const error = new BusinessRuleError("TEST", "test");
    expect(errors.isApplicationError(error)).toBe(false);
    expect(isCodedError(error)).toBe(true);
  });

  it("returns false for a CodedError that extends no layer base", () => {
    const error = new LayerlessCodedError("TEST", "test");
    expect(errors.isApplicationError(error)).toBe(false);
    expect(isCodedError(error)).toBe(true);
  });

  // Positive control the two one-piece-short cases below are measured against.
  // It is also what pins the registry key itself: a typo in `errors.ts` leaves
  // both module graphs agreeing on the same wrong symbol, and every
  // foreign-graph case stays green — only this forgery, which re-derives the
  // key, goes red.
  it("returns true for a forgery carrying the contract and the layer brand", () => {
    expect(errors.isApplicationError(applicationForgery("conflict"))).toBe(
      true,
    );
  });

  // That forgery minus the layer brand: still a complete `CodedError` forgery,
  // so the rejection isolates the layer brand.
  it("returns false for an object forging only the CodedError contract", () => {
    const impostor = brandedContract("conflict");
    expect(errors.isApplicationError(impostor)).toBe(false);
    expect(isCodedError(impostor)).toBe(true);
  });

  // That forgery minus everything but the layer brand: the contract check is
  // what rejects it, so a bare branded object cannot claim the abstract
  // class's `toSerialized()` / `code` / `message` promise.
  it("returns false for a bare object carrying only the layer brand", () => {
    expect(errors.isApplicationError({ [APPLICATION_ERROR_BRAND]: true })).toBe(
      false,
    );
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(errors.isApplicationError(value)).toBe(false);
  });
});

describe("SystemError", () => {
  it("reports retryable only for transient codes", () => {
    expect(
      new errors.SystemError(errors.SystemErrorCode.DatabaseError, "test")
        .retryable,
    ).toBe(false);
    expect(
      new errors.SystemError(errors.SystemErrorCode.NetworkError, "test")
        .retryable,
    ).toBe(true);
  });
});

describe("across a serialization boundary", () => {
  // The remnant a real error leaves once it crosses the boundaries the brand's
  // JSDoc names: both drop the symbol-keyed brands, so past them the
  // `SerializedError` envelope is the contract and every guard here must
  // answer false. Spreading first keeps the enumerable own members
  // (`code` / `serializedKind`) in play, mirroring the presentation layer's
  // remnant fixtures.
  const REMNANTS: ReadonlyArray<readonly [string, unknown]> = [
    [
      "structuredClone",
      structuredClone({ ...new ConflictError("TEST", "test") }),
    ],
    [
      "a JSON round-trip",
      JSON.parse(JSON.stringify({ ...new ConflictError("TEST", "test") })),
    ],
  ];

  it.each(REMNANTS)(
    "isApplicationError returns false for the remnant left by %s",
    (_label, value) => {
      expect(errors.isApplicationError(value)).toBe(false);
    },
  );

  it.each(REMNANTS)(
    "isConflictError returns false for the remnant left by %s",
    (_label, value) => {
      expect(errors.isConflictError(value)).toBe(false);
    },
  );
});

describe("across a duplicated module graph", () => {
  it.each(APPLICATION_CASES)(
    "matches a $kind error built in another module graph",
    async (testCase) => {
      const foreign = await loadForeignGraph();
      expect(foreign.isApplicationError).not.toBe(errors.isApplicationError);

      const error = testCase.build(foreign);
      expect(testCase.guard(error)).toBe(true);
      expect(errors.isApplicationError(error)).toBe(true);
      expect(isCodedError(error)).toBe(true);
    },
  );

  it("keeps instanceof broken while the guards keep answering", async () => {
    const foreign = await loadForeignGraph();
    expect(foreign.ConflictError).not.toBe(ConflictError);

    const error = new foreign.ConflictError("TEST", "test");

    // biome-ignore lint/plugin: negative control — this false is the failure mode the structural guards exist to replace
    expect(error instanceof ConflictError).toBe(false);
    // biome-ignore lint/plugin: negative control — the abstract base is duplicated too
    expect(error instanceof ApplicationError).toBe(false);

    expect(errors.isConflictError(error)).toBe(true);
    // The dup'd module runs its own `Symbol.for("@repo/core/ApplicationError")`;
    // the registry is what makes the two brands the same symbol.
    expect(errors.isApplicationError(error)).toBe(true);
    expect(errors.isNotFoundError(error)).toBe(false);
  });

  it("does not mistake a foreign BusinessRuleError for an ApplicationError", async () => {
    const foreignDomain = await loadForeignDomainGraph();
    const error = new foreignDomain.BusinessRuleError("TEST", "test");

    expect(isBusinessRuleError(error)).toBe(true);
    expect(errors.isApplicationError(error)).toBe(false);
    expect(isCodedError(error)).toBe(true);
  });
});
