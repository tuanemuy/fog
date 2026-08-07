import { describe, expect, it } from "vitest";
import {
  CODED_ERROR_BRAND,
  CodedError,
  hasSerializedKind,
  isCodedError,
  isSerializableError,
  type SerializedErrorBase,
} from "../error";

// Local stand-ins rather than `ConflictError` / `BusinessRuleError`: `lib/` sits
// outside the layered tree and every layer depends on it, so its tests must not
// depend on a layer.
class TestCodedError extends CodedError {
  override readonly name = "TestCodedError";
  readonly serializedKind = "test";

  override toSerialized(): SerializedErrorBase & { kind: "test" } {
    return {
      kind: this.serializedKind,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

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

describe("CODED_ERROR_BRAND", () => {
  it("is present on a CodedError subclass", () => {
    expect(CODED_ERROR_BRAND in new TestCodedError("TEST", "test")).toBe(true);
  });

  it("is absent on a plain Error", () => {
    expect(CODED_ERROR_BRAND in new Error("plain")).toBe(false);
  });

  it("is absent on a plain object", () => {
    expect(CODED_ERROR_BRAND in {}).toBe(false);
  });
});

describe("isCodedError", () => {
  it("returns true for a CodedError subclass", () => {
    expect(isCodedError(new TestCodedError("TEST", "test"))).toBe(true);
    expect(isCodedError(new OtherCodedError("TEST", "test"))).toBe(true);
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(isCodedError(value)).toBe(false);
  });

  it("returns false for an object that only mimics the serialized shape", () => {
    expect(isCodedError({ serializedKind: "test" })).toBe(false);
    expect(isCodedError({ name: "TestCodedError", code: "TEST" })).toBe(false);
  });
});

describe("hasSerializedKind", () => {
  it("returns true when the brand and the discriminator both match", () => {
    expect(hasSerializedKind(new TestCodedError("TEST", "test"), "test")).toBe(
      true,
    );
  });

  it("returns false when the brand is present but the discriminator differs", () => {
    expect(hasSerializedKind(new OtherCodedError("TEST", "test"), "test")).toBe(
      false,
    );
  });

  it("returns false when the discriminator matches but the brand is absent", () => {
    expect(hasSerializedKind({ serializedKind: "test" }, "test")).toBe(false);
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(hasSerializedKind(value, "test")).toBe(false);
  });
});

describe("isSerializableError", () => {
  it("returns true for a CodedError subclass", () => {
    expect(isSerializableError(new TestCodedError("TEST", "test"))).toBe(true);
  });

  it("returns true for any object exposing toSerialized", () => {
    expect(
      isSerializableError({ toSerialized: () => ({ kind: "x", message: "" }) }),
    ).toBe(true);
  });

  it("returns false when toSerialized is not callable", () => {
    expect(isSerializableError({ toSerialized: "not-a-function" })).toBe(false);
  });

  it.each(NON_ERROR_VALUES)("returns false for %s", (_label, value) => {
    expect(isSerializableError(value)).toBe(false);
  });
});

describe("serializedKind", () => {
  it("agrees with the kind that toSerialized emits", () => {
    for (const error of [
      new TestCodedError("TEST", "test"),
      new OtherCodedError("TEST", "test"),
    ]) {
      expect(error.serializedKind).toBe(error.toSerialized().kind);
    }
  });
});

describe("across a duplicated module graph", () => {
  it("resolves the brand to the same symbol from two module instances", async () => {
    const foreign = await loadForeignGraph();

    expect(foreign.CodedError).not.toBe(CodedError);
    // `Symbol.for` goes through the realm-wide registry; swapping it for
    // `Symbol()` breaks exactly this equality and nothing else.
    expect(foreign.CODED_ERROR_BRAND).toBe(CODED_ERROR_BRAND);
  });

  it("recognises an error built on the foreign CodedError", async () => {
    const foreign = await loadForeignGraph();

    class ForeignGraphError extends foreign.CodedError {
      override readonly name = "ForeignGraphError";
      readonly serializedKind = "test";

      override toSerialized(): SerializedErrorBase & { kind: "test" } {
        return {
          kind: this.serializedKind,
          code: this.code,
          message: this.message,
          retryable: this.retryable,
        };
      }
    }

    const error = new ForeignGraphError("TEST", "test");

    // biome-ignore lint/plugin: negative control — this false is the failure mode the structural guards exist to replace
    expect(error instanceof CodedError).toBe(false);
    expect(isCodedError(error)).toBe(true);
    expect(hasSerializedKind(error, "test")).toBe(true);
    expect(hasSerializedKind(error, "other")).toBe(false);
  });
});
