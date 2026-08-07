import { CodedError, type SerializedErrorBase } from "@repo/core/lib/error";
import { describe, expect, it } from "vitest";
import {
  BusinessRuleError,
  isBusinessRuleError,
  isRehydrationError,
  RehydrationError,
} from "../error";

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
    const foreign = new ForeignBusinessError("TEST", "test");

    expect(isBusinessRuleError(foreign)).toBe(true);
    // biome-ignore lint/plugin: negative control — the guard matched something that is not this class, which is why its return type is structural
    expect(foreign instanceof BusinessRuleError).toBe(false);
    expect(foreign.toSerialized().kind).toBe(
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
