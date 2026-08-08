import { describe, expect, it } from "vitest";
import {
  CodedError,
  hasSerializedKind,
  isCodedError,
  isSerializableError,
  type SerializedErrorBase,
} from "../error";

// The brand is module-private, so the test re-derives it through the registry
// instead of importing it. That is the same lookup the implementation performs,
// so this constant is only equal to the real brand while `Symbol.for` is what
// mints it.
const CODED_ERROR_BRAND: unique symbol = Symbol.for("@repo/core/CodedError");

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

// Compile-time fixture for the binding `CodedError` puts on `serializedKind`:
// the base derives its type from this class's own `toSerialized()`, so the
// disagreement below must stay a TS2416. If the binding is ever weakened back
// to `string`, the suppression becomes unused and `tsgo` fails on it.
class DriftingError extends CodedError {
  override readonly name = "DriftingError";
  // @ts-expect-error TS2416 — declares "test" while toSerialized() emits "other"
  readonly serializedKind = "test";

  override toSerialized(): SerializedErrorBase & { kind: "other" } {
    return {
      kind: "other",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

function brandedImpostor(props: Record<string, unknown>): unknown {
  return { [CODED_ERROR_BRAND]: true, ...props };
}

// The members `isCodedError` reads off a value, held apart so each negative case
// below can drop exactly one of them and satisfy the rest.
const FORGED_KIND = "test";
const FORGED_CODE = "TEST";
const FORGED_MESSAGE = "test";
const forgedToSerialized = () => ({
  kind: FORGED_KIND,
  code: FORGED_CODE,
  message: FORGED_MESSAGE,
});

const COMPLETE_FORGERY: unknown = brandedImpostor({
  serializedKind: FORGED_KIND,
  code: FORGED_CODE,
  message: FORGED_MESSAGE,
  toSerialized: forgedToSerialized,
});

// One entry per condition the guard checks, each satisfying the other four. That
// is what makes every condition individually load-bearing: a negative case that
// misses several conditions at once cannot say which one rejected it, and that
// is how `CODED_ERROR_BRAND in value` could be deleted from `isCodedError` with
// the whole suite still green.
const ONE_CONDITION_SHORT: ReadonlyArray<readonly [string, unknown]> = [
  [
    "the brand",
    {
      serializedKind: FORGED_KIND,
      code: FORGED_CODE,
      message: FORGED_MESSAGE,
      toSerialized: forgedToSerialized,
    },
  ],
  [
    "serializedKind",
    brandedImpostor({
      code: FORGED_CODE,
      message: FORGED_MESSAGE,
      toSerialized: forgedToSerialized,
    }),
  ],
  [
    "toSerialized",
    brandedImpostor({
      serializedKind: FORGED_KIND,
      code: FORGED_CODE,
      message: FORGED_MESSAGE,
    }),
  ],
  [
    "code",
    brandedImpostor({
      serializedKind: FORGED_KIND,
      message: FORGED_MESSAGE,
      toSerialized: forgedToSerialized,
    }),
  ],
  [
    "message",
    brandedImpostor({
      serializedKind: FORGED_KIND,
      code: FORGED_CODE,
      toSerialized: forgedToSerialized,
    }),
  ],
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

  it("returns false for a branded value that cannot answer the contract", () => {
    expect(isCodedError(brandedImpostor({ serializedKind: "test" }))).toBe(
      false,
    );
    expect(
      isCodedError(brandedImpostor({ toSerialized: () => ({ kind: "test" }) })),
    ).toBe(false);
    expect(
      isCodedError(
        brandedImpostor({
          serializedKind: 1,
          toSerialized: () => ({ kind: "test" }),
        }),
      ),
    ).toBe(false);
    expect(
      isCodedError(
        brandedImpostor({
          serializedKind: "test",
          toSerialized: "not-a-function",
        }),
      ),
    ).toBe(false);
  });

  // The brand is reachable through `Symbol.for`, so a value that answers the
  // whole contract is indistinguishable from a real one. This documents the
  // limit rather than a property worth relying on — and it is the positive
  // control the one-condition-short cases below are measured against.
  it("returns true for a forgery that satisfies every checked condition", () => {
    expect(isCodedError(COMPLETE_FORGERY)).toBe(true);
  });

  it.each(ONE_CONDITION_SHORT)(
    "returns false for that same forgery missing only %s",
    (_label, value) => {
      expect(isCodedError(value)).toBe(false);
    },
  );
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

  it("returns false when the brand and discriminator match but toSerialized is missing", () => {
    expect(
      hasSerializedKind(brandedImpostor({ serializedKind: "test" }), "test"),
    ).toBe(false);
  });

  // `hasSerializedKind` is `isCodedError` plus a discriminator comparison, so
  // every condition of the former has to stay load-bearing here too — including
  // the brand, which is the only thing separating the value in the first case
  // from the one in the second.
  it("returns true for a forgery that satisfies every checked condition", () => {
    expect(hasSerializedKind(COMPLETE_FORGERY, "test")).toBe(true);
  });

  it.each(ONE_CONDITION_SHORT)(
    "returns false for that same forgery missing only %s",
    (_label, value) => {
      expect(hasSerializedKind(value, "test")).toBe(false);
    },
  );

  // `TKind extends string` accepts anything, so a mistyped kind cannot be a
  // compile error — it silently degrades into a guard that never matches.
  it("returns false for a kind no class declares", () => {
    expect(hasSerializedKind(new TestCodedError("TEST", "test"), "tset")).toBe(
      false,
    );
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

  // Runtime cannot detect the drift the type binding rejects: `DriftingError`
  // only exists because its declaration is suppressed, and it behaves exactly
  // like a class that reports the wrong kind everywhere the guards look.
  it("is what the guards read, so a drifting declaration misroutes silently", () => {
    const error = new DriftingError("TEST", "test");

    expect(hasSerializedKind(error, "test")).toBe(true);
    expect(error.toSerialized().kind).toBe("other");
  });
});

describe("across a serialization boundary", () => {
  // The remnant a real error leaves once it crosses the boundaries the brand's
  // JSDoc names as its Lifetime limit: `structuredClone` and JSON both drop
  // symbol-keyed properties, and `toSerialized` lives on the prototype, so
  // neither survives — past these boundaries the `SerializedError` envelope is
  // the contract and the guards must answer false. Spreading first keeps the
  // enumerable own members (`code` / `serializedKind`) in play, mirroring the
  // presentation layer's remnant fixtures.
  const REMNANTS: ReadonlyArray<readonly [string, unknown]> = [
    [
      "structuredClone",
      structuredClone({ ...new TestCodedError("TEST", "test") }),
    ],
    [
      "a JSON round-trip",
      JSON.parse(JSON.stringify({ ...new TestCodedError("TEST", "test") })),
    ],
  ];

  it.each(REMNANTS)(
    "isCodedError returns false for the remnant left by %s",
    (_label, value) => {
      expect(isCodedError(value)).toBe(false);
    },
  );

  it.each(REMNANTS)(
    "hasSerializedKind returns false for the remnant left by %s",
    (_label, value) => {
      expect(hasSerializedKind(value, "test")).toBe(false);
    },
  );
});

describe("across a duplicated module graph", () => {
  it("brands foreign instances with the symbol this graph resolves", async () => {
    const foreign = await loadForeignGraph();

    expect(foreign.CodedError).not.toBe(CodedError);

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

    // The brand is module-private, so the two graphs can only be compared
    // through an instance. `Symbol.for` goes through the realm-wide registry;
    // swapping it for `Symbol()` gives the foreign copy a symbol this graph
    // cannot name, and breaks exactly this membership test.
    expect(CODED_ERROR_BRAND in new ForeignGraphError("TEST", "test")).toBe(
      true,
    );
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
