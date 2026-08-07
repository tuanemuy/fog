import {
  BusinessRuleError,
  isBusinessRuleError,
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
import { ApplicationError, ConflictError } from "../errors";

type ErrorsModule = typeof errors;

// Re-derived instead of imported: the brand is module-private, and going
// through the registry is exactly the lookup that makes it work across module
// graphs — a test that imported it would not exercise that.
const CODED_ERROR_BRAND = Symbol.for("@repo/core/CodedError");

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
      },
    );

    it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
      expect(subject.guard(value)).toBe(false);
    });
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
    expect(foreign.toSerialized()).toEqual({
      kind: "conflict",
      code: "TEST",
      message: "test",
      retryable: false,
    });
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

  // The brand is spoofable and `isCodedError` only closes the accidental
  // shapes, so a deliberate forgery satisfying the whole contract still passes
  // it. The layer brand is a separate property and is not forged here.
  it("returns false for an object forging the CodedError contract", () => {
    const impostor = {
      [CODED_ERROR_BRAND]: true,
      serializedKind: "conflict",
      toSerialized: () => ({
        kind: "conflict",
        code: "TEST",
        message: "test",
        retryable: false,
      }),
    };
    expect(errors.isApplicationError(impostor)).toBe(false);
    expect(isCodedError(impostor)).toBe(true);
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
