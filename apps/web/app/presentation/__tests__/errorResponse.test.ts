import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type SerializedConflictError,
  SystemError,
  SystemErrorCode,
  UnauthorizedError,
  ValidationError,
} from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import { CodedError } from "@repo/core/lib/error";
import { describe, expect, it } from "vitest";
import {
  AppServerError,
  asSerializedError,
  extractSerializedError,
  httpStatusFor,
  isAppServerError,
  redactForClient,
  type SerializedError,
  type SerializedErrorBase,
  type SerializedErrorKind,
  serializeError,
  UNVERIFIED_SERIALIZED_ERROR,
} from "../errorResponse";

// Shaped like the strings that actually leak: a driver tag, a table name,
// and an absolute server path.
const INTERNAL_DETAIL =
  "D1_ERROR: no such table: users (/var/task/packages/core/adapters/d1/userRepository.js:120)";

const LOGIN_FAILURE_MESSAGE = "Invalid email or password";

// Built from the real error classes rather than hand-written literals, so
// the fixture also pins which class lands on which `kind`. Typed as a total
// record: a new member of the `SerializedError` union fails to compile here
// until it is classified below.
const SAMPLES = {
  business: serializeError(
    new BusinessRuleError("IDENTITY_EMAIL_TOO_LONG", "Email is too long"),
  ),
  notFound: serializeError(new NotFoundError("USER_NOT_FOUND", "No such user")),
  conflict: serializeError(
    new ConflictError("EMAIL_ALREADY_REGISTERED", "Email already registered"),
  ),
  unauthorized: serializeError(
    new UnauthorizedError("SESSION_REQUIRED", "Sign in required"),
  ),
  forbidden: serializeError(
    new ForbiddenError("NOT_RESOURCE_OWNER", "Not the owner"),
  ),
  validation: serializeError(
    new ValidationError("INVALID_CREDENTIALS", LOGIN_FAILURE_MESSAGE, {
      email: [LOGIN_FAILURE_MESSAGE],
    }),
  ),
  system: serializeError(
    new SystemError(SystemErrorCode.DatabaseError, INTERNAL_DETAIL),
  ),
  unknown: serializeError(new Error(INTERNAL_DETAIL)),
} satisfies Record<SerializedErrorKind, SerializedError>;

const KINDS = Object.keys(SAMPLES) as readonly SerializedErrorKind[];

// `errorResponse.ts` keeps the brand module-private; the realm-wide registry
// is what makes the same symbol reachable from here, which is the same reason
// a second module graph observes it. Re-deriving it lets the branded-but-
// malformed cases below reach `isAppServerError`'s payload check, which no
// unbranded fixture can.
const APP_SERVER_ERROR_BRAND = Symbol.for("@repo/web/AppServerError");

const REDACTED_KINDS = [
  "system",
  "unknown",
] as const satisfies ReadonlyArray<SerializedErrorKind>;

const PASSED_THROUGH_KINDS = KINDS.filter(
  (kind) => !REDACTED_KINDS.some((redacted) => redacted === kind),
);

// Where a payload that fails verification lands once it reaches
// `extractSerializedError`: the value is not a `SerializableError`, so the last
// stage falls through to `errorMessage()`, which has no message to read off a
// plain object.
const UNVERIFIED_FALLBACK = {
  kind: "unknown",
  code: null,
  message: "Unexpected error",
} as const satisfies SerializedError;

// `AppServerError`'s constructor is typed against the verified union, but the
// payloads it actually holds have only been through `asSerializedError`. The
// cast stands in for that gap so the tests can build the shapes a client can
// post.
function fromTheWire(value: Record<string, unknown>): SerializedError {
  return value as unknown as SerializedError;
}

function verified(value: unknown): SerializedError {
  const result = asSerializedError(value);
  if (result === null) throw new Error("expected the payload to verify");
  return result;
}

describe("serializeError", () => {
  it.each(KINDS)("projects the %s sample onto that kind", (kind) => {
    expect(SAMPLES[kind].kind).toBe(kind);
  });

  // `throw "..."` is legal JavaScript and now reaches the server side too, via
  // `toClientError`. Without this the string arm of `errorMessage` is dead
  // weight to the suite: dropping it degrades a bare-string throw to
  // "Unexpected error" and nothing notices.
  it("reports a thrown string as its own message", () => {
    expect(serializeError("boom")).toEqual({
      kind: "unknown",
      code: null,
      message: "boom",
    });
  });

  // The counterweight, so the case above cannot be satisfied by a guard that
  // stringifies everything: a non-string, non-Error throw has no message to
  // read and must land on the fixed fallback.
  it("reports a thrown non-string as the fixed fallback message", () => {
    expect(serializeError(42)).toEqual({
      kind: "unknown",
      code: null,
      message: "Unexpected error",
    });
  });

  type SerializedLayerlessError = SerializedErrorBase & { kind: "layerless" };

  // A `CodedError` whose `kind` is outside the union assembled in
  // `errorResponse.ts`. The branch that receives it cannot be closed by a type
  // — the union aggregates each layer's variants, so `lib/` (which every layer
  // depends on) cannot name it back — which is why it is pinned here instead.
  class LayerlessError extends CodedError {
    override readonly name = "LayerlessError";
    readonly serializedKind: SerializedLayerlessError["kind"] = "layerless";

    override toSerialized(): SerializedLayerlessError {
      return {
        kind: "layerless",
        code: this.code,
        message: this.message,
        retryable: false,
      };
    }
  }

  // The distinction that matters: this must not collapse onto the
  // `errorMessage()` fallback at the top of `serializeError`, which would
  // report `code: null` and the raw `Error.message`. A layerless error still
  // reaches the logger carrying the detail its own class chose — `retryable`
  // included, since the fallback claims to carry the base fields over.
  it("carries code, message and retryable over for a kind outside the union", () => {
    expect(serializeError(new LayerlessError("X", "boom"))).toEqual({
      kind: "unknown",
      code: "X",
      message: "boom",
      retryable: false,
    });
  });

  // A `SerializedLayerlessError` that never set `retryable`. The counterweight
  // to the carry-over above: absent must stay absent rather than become
  // present-and-undefined, per `exactOptionalPropertyTypes`.
  class BareLayerlessError extends CodedError {
    override readonly name = "BareLayerlessError";
    readonly serializedKind: SerializedLayerlessError["kind"] = "layerless";

    override toSerialized(): SerializedLayerlessError {
      return { kind: "layerless", code: this.code, message: this.message };
    }
  }

  it("leaves retryable absent when the layerless error declares none", () => {
    const result = serializeError(new BareLayerlessError("X", "boom"));

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
  });

  // The fallback fires precisely when `asSerializedError` answered null — for
  // a union kind, that can mean the payload's values failed the `typeof`
  // checks. Carrying such a value over verbatim would put `code: {}` /
  // `retryable: "yes"` into a value typed `SerializedError`; the fallback has
  // to run the same checks its sibling does and degrade each field instead.
  it("drops ill-typed code, message and retryable instead of carrying them into the fallback", () => {
    class IllTypedError extends CodedError {
      override readonly name = "IllTypedError";
      readonly serializedKind: SerializedConflictError["kind"] = "conflict";

      override toSerialized(): SerializedConflictError {
        return {
          kind: "conflict",
          code: {},
          message: 5,
          retryable: "yes",
        } as unknown as SerializedConflictError;
      }
    }

    const result = serializeError(new IllTypedError("X", "boom"));

    // `message` degrades to `errorMessage()`'s Error arm — the message the
    // constructor set — not to the ill-typed number.
    expect(result).toEqual({ kind: "unknown", code: null, message: "boom" });
    expect("retryable" in result).toBe(false);
  });

  // The union-kind branch used to hand `toSerialized()`'s object back by
  // reference, so an extra key riding on it would survive into the value the
  // middleware spreads through `redactForClient`. These two pin the rebuild
  // that replaced it: known keys only, and never the same object.
  it("rebuilds a union-kind payload from known keys instead of trusting toSerialized()", () => {
    class LeakyConflictError extends CodedError {
      override readonly name = "LeakyConflictError";
      readonly serializedKind: SerializedConflictError["kind"] = "conflict";

      override toSerialized(): SerializedConflictError {
        return {
          kind: "conflict",
          code: this.code,
          message: this.message,
          evil: "pii",
        } as SerializedConflictError;
      }
    }

    const result = serializeError(new LeakyConflictError("X", "boom"));

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
  });

  it("does not return toSerialized()'s value by reference for a union kind", () => {
    const canned: SerializedConflictError = {
      kind: "conflict",
      code: "X",
      message: "boom",
      retryable: false,
    };
    class CannedConflictError extends CodedError {
      override readonly name = "CannedConflictError";
      readonly serializedKind: SerializedConflictError["kind"] = "conflict";

      override toSerialized(): SerializedConflictError {
        return canned;
      }
    }

    const result = serializeError(new CannedConflictError("X", "boom"));

    expect(result).not.toBe(canned);
    expect(result).toEqual(canned);
  });
});

// Every assertion here is about the *rebuild*, not the validation: returning
// the caller's object would satisfy a `toEqual` / `toMatchObject` on the known
// keys just as well. `Object.keys` is what tells the two apart — and it is also
// the only form that distinguishes an absent optional key from one present with
// `undefined`, which is what `exactOptionalPropertyTypes` promises.
describe("asSerializedError", () => {
  it("drops a key the union does not declare", () => {
    const forged = fromTheWire({
      kind: "conflict",
      code: "X",
      message: "m",
      evil: "pii",
    });

    const result = verified(forged);

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
    // `redactForClient` spreads its input, so a surviving unknown key would
    // ride the spread all the way onto the wire.
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
    expect(JSON.stringify(redactForClient(result))).not.toContain("evil");
  });

  it("drops fieldErrors on a kind that does not declare it", () => {
    expect(
      verified({
        kind: "conflict",
        code: "X",
        message: "m",
        fieldErrors: { email: ["required"] },
      }),
    ).toEqual({ kind: "conflict", code: "X", message: "m" });
  });

  it("keeps fieldErrors on the validation kind", () => {
    expect(
      verified({
        kind: "validation",
        code: "X",
        message: "m",
        fieldErrors: { email: ["required"] },
      }),
    ).toEqual({
      kind: "validation",
      code: "X",
      message: "m",
      fieldErrors: { email: ["required"] },
    });
  });

  // `validation` rebuilds through its own return, so the conflict case above
  // says nothing about it — and it is the variant where a surviving unknown key
  // does the most damage: `redactForClient` passes `validation` through by
  // spreading it, so the key would reach the client verbatim, and the inbound
  // leg of the serialization adapter lets a client choose the payload.
  it("drops a key the union does not declare on the validation kind", () => {
    const result = verified({
      kind: "validation",
      code: "X",
      message: "m",
      fieldErrors: { email: ["required"] },
      evil: "pii",
    });

    expect(Object.keys(result)).toEqual([
      "kind",
      "code",
      "message",
      "fieldErrors",
    ]);
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
    expect(JSON.stringify(redactForClient(result))).not.toContain("evil");
  });

  // The absent-`fieldErrors` case leaves the branch through a second return
  // that rebuilds independently of the one above, so it needs its own pin.
  // `fieldErrors` must stay absent rather than present-and-undefined, for the
  // same `exactOptionalPropertyTypes` reason as `retryable`.
  it("drops a key the union does not declare on a validation payload carrying no fieldErrors", () => {
    const result = verified({
      kind: "validation",
      code: "X",
      message: "m",
      evil: "pii",
    });

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
    expect("fieldErrors" in result).toBe(false);
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
    expect(JSON.stringify(redactForClient(result))).not.toContain("evil");
  });

  // The nested half of the rebuild claim. `isFieldErrors` sees only
  // string-keyed enumerable values and array elements, so what these fixtures
  // smuggle — an extra own property grafted onto the messages array, a
  // symbol-keyed entry — survives validation and dies only in the rebuild.
  // Neither shows up in `JSON.stringify`, so the assertions have to read the
  // own properties directly.
  it("rebuilds the messages arrays inside fieldErrors, dropping grafted own properties", () => {
    const messages = Object.assign(["required"], {
      evil: "pii",
      [Symbol.for("evil")]: "pii",
    });

    const result = verified(
      fromTheWire({
        kind: "validation",
        code: "X",
        message: "m",
        fieldErrors: { email: messages },
      }),
    );

    if (result.kind !== "validation" || result.fieldErrors === undefined) {
      throw new Error("expected a validation payload carrying fieldErrors");
    }
    const rebuilt = result.fieldErrors.email;
    expect(rebuilt).not.toBe(messages);
    expect(rebuilt).toEqual(["required"]);
    expect(Object.getOwnPropertyNames(rebuilt)).toEqual(["0", "length"]);
    expect(Object.getOwnPropertySymbols(rebuilt)).toEqual([]);
  });

  it("rebuilds the fieldErrors record itself, dropping symbol-keyed entries", () => {
    const fieldErrors = {
      email: ["required"],
      [Symbol.for("evil")]: "pii",
    };

    const result = verified(
      fromTheWire({ kind: "validation", code: "X", message: "m", fieldErrors }),
    );

    if (result.kind !== "validation" || result.fieldErrors === undefined) {
      throw new Error("expected a validation payload carrying fieldErrors");
    }
    expect(result.fieldErrors).not.toBe(fieldErrors);
    expect(Object.getOwnPropertyNames(result.fieldErrors)).toEqual(["email"]);
    expect(Object.getOwnPropertySymbols(result.fieldErrors)).toEqual([]);
  });

  // The one own key the rebuild cannot copy over: `rebuilt[field] = copy`
  // on an own `"__proto__"` key hits the `Object.prototype.__proto__` setter,
  // which swaps the accumulator's prototype for the attacker-supplied array
  // instead of adding a property. `JSON.parse` materialises the key as an own
  // property, so the shape is wire-reachable through the adapter's inbound
  // leg. Rejection, not a silent drop: the getter / symbol cases above prove
  // what the rebuild strips, this one pins what it refuses outright.
  it("rejects a fieldErrors record carrying an own __proto__ key", () => {
    const fieldErrors: unknown = JSON.parse(
      '{"__proto__": ["pii"], "email": ["required"]}',
    );
    // Precondition: the key really is an own property, not the inherited
    // accessor — otherwise this case would collapse onto the happy path.
    expect(Object.hasOwn(fieldErrors as object, "__proto__")).toBe(true);

    expect(
      asSerializedError({
        kind: "validation",
        code: "X",
        message: "m",
        fieldErrors,
      }),
    ).toBeNull();
  });

  // `Array.prototype.every` skips holes, so a sparse messages array would
  // pass an in-place check while the rebuilt copy materialises each hole as an
  // `undefined` element — a `readonly string[]` contract violation that
  // `JSON.stringify` would put on the wire as `null`. Validating the copy is
  // what makes the hole a rejection instead.
  it("rejects a sparse messages array inside fieldErrors", () => {
    const sparse = ["ok"];
    sparse.length = 2;

    expect(
      asSerializedError({
        kind: "validation",
        code: null,
        message: "m",
        fieldErrors: { email: sparse },
      }),
    ).toBeNull();
  });

  // The old shape validated in one enumeration and rebuilt in another, so a
  // getter could answer a well-formed array to the validator and a poisoned
  // one to the rebuild. Reading each property exactly once and validating the
  // copy closes that: the second reading never happens, so what was validated
  // is what comes out.
  it("reads each fieldErrors property once, keeping a two-faced getter's second reading out of the result", () => {
    let reads = 0;
    const fieldErrors = {
      get email() {
        reads += 1;
        return reads === 1 ? ["ok"] : [{ evil: "pii" }];
      },
    };

    const result = verified(
      fromTheWire({ kind: "validation", code: "X", message: "m", fieldErrors }),
    );

    if (result.kind !== "validation" || result.fieldErrors === undefined) {
      throw new Error("expected a validation payload carrying fieldErrors");
    }
    expect(reads).toBe(1);
    expect(result.fieldErrors.email).toEqual(["ok"]);
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
  });

  it("leaves an absent retryable absent rather than present-and-undefined", () => {
    const result = verified({ kind: "conflict", code: "X", message: "m" });

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
    expect("retryable" in result).toBe(false);
  });

  it("carries retryable through when the payload declares one", () => {
    expect(
      verified({ kind: "system", code: "X", message: "m", retryable: true }),
    ).toEqual({ kind: "system", code: "X", message: "m", retryable: true });
  });

  it("accepts a null code, which is what the redacted form carries", () => {
    expect(verified({ kind: "unknown", code: null, message: "m" })).toEqual({
      kind: "unknown",
      code: null,
      message: "m",
    });
  });
});

describe("redactForClient", () => {
  it.each(PASSED_THROUGH_KINDS)("hands %s to the client as-is", (kind) => {
    expect(redactForClient(SAMPLES[kind])).toEqual(SAMPLES[kind]);
  });

  // The auth forms read their wording off `code`: `errorField.ts` resolves the
  // field through `FIELD_BY_CODE[error.code]` and `errorDisplay.ts` picks the
  // message the same way. Folding `validation` into the redacted branch would
  // turn every login failure into "システムエラーが発生しました", so the
  // pass-through is pinned literally here and not derived from the fixture.
  it("keeps the code and field errors a login failure is rendered from", () => {
    expect(redactForClient(SAMPLES.validation)).toEqual({
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: LOGIN_FAILURE_MESSAGE,
      retryable: false,
      fieldErrors: { email: [LOGIN_FAILURE_MESSAGE] },
    });
  });

  it("replaces a system payload with a fixed public message", () => {
    expect(redactForClient(SAMPLES.system)).toEqual({
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    });
  });

  it("replaces an unknown payload with a fixed public message", () => {
    expect(redactForClient(SAMPLES.unknown)).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
  });

  it.each(REDACTED_KINDS)("leaks no server detail through %s", (kind) => {
    const wire = JSON.stringify(redactForClient(SAMPLES[kind]));

    expect(wire).not.toContain("D1_ERROR");
    expect(wire).not.toContain("users");
    expect(wire).not.toContain("/var/task");
    expect(wire).not.toContain(SystemErrorCode.DatabaseError);
  });

  // The middleware derives the status from the *redacted* value, so dropping
  // `kind` here would silently turn every 500 into the framework default.
  it.each(KINDS)("preserves the kind of %s", (kind) => {
    expect(redactForClient(SAMPLES[kind]).kind).toBe(kind);
  });
});

describe("httpStatusFor", () => {
  const EXPECTED = {
    business: 422,
    notFound: 404,
    conflict: 409,
    unauthorized: 401,
    forbidden: 403,
    validation: 422,
    system: 500,
    unknown: 500,
  } satisfies Record<SerializedErrorKind, number>;

  it.each(KINDS)("maps %s to its documented status", (kind) => {
    expect(httpStatusFor(SAMPLES[kind])).toBe(EXPECTED[kind]);
  });

  it("still answers 500 for a redacted system error", () => {
    expect(httpStatusFor(redactForClient(SAMPLES.system))).toBe(500);
    expect(httpStatusFor(redactForClient(SAMPLES.unknown))).toBe(500);
  });
});

describe("AppServerError", () => {
  // The constructor drops `.stack` because a transport that bypasses the
  // serialization adapter falls back to seroval's default `Error` handling and
  // puts whatever `.stack` holds — server paths, module layout — on the wire.
  // `in` rather than a falsiness check: the property has to be absent, since
  // seroval serializes a present-but-empty one just the same.
  it("carries no stack for a default Error serialization to leak", () => {
    expect("stack" in new AppServerError(SAMPLES.conflict)).toBe(false);
  });
});

describe("isAppServerError", () => {
  const serialized = serializeError(
    new ConflictError("EMAIL_ALREADY_REGISTERED", "test"),
  );

  it("returns true for an AppServerError instance", () => {
    expect(isAppServerError(new AppServerError(serialized))).toBe(true);
  });

  it("returns false for null", () => {
    expect(isAppServerError(null)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isAppServerError({})).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isAppServerError(new Error("plain"))).toBe(false);
  });

  it("returns false for a plain object with a name property", () => {
    expect(isAppServerError({ name: "AppServerError" })).toBe(false);
  });

  // Positive control for the branded-but-malformed table below: without it a
  // drift in the brand key would make every one of those cases pass for the
  // wrong reason, leaving the payload check uncovered again.
  it("returns true for a branded literal carrying a message and a well-formed payload", () => {
    expect(
      isAppServerError({
        [APP_SERVER_ERROR_BRAND]: true,
        message: "test",
        serialized,
      }),
    ).toBe(true);
  });

  // The narrow target is an `Error` subclass, so the guard checks the minimal
  // `Error` shape too: a branded literal with a valid payload but no `message`
  // must not be narrowed into a type that promises `message: string`.
  it("returns false for a branded literal missing the Error shape's message", () => {
    expect(
      isAppServerError({ [APP_SERVER_ERROR_BRAND]: true, serialized }),
    ).toBe(false);
  });

  // The brand alone is not enough: `AppServerError`'s only job is to carry a
  // payload the status mapping can read, so a branded value without one has to
  // fall through to the `unknown` / 500 path rather than be trusted.
  const MALFORMED_PAYLOADS: ReadonlyArray<readonly [string, object]> = [
    ["no serialized property at all", {}],
    ["a null payload", { serialized: null }],
    ["a non-object payload", { serialized: "conflict" }],
    ["a payload missing kind", { serialized: { message: "x" } }],
    ["a payload missing message", { serialized: { kind: "conflict" } }],
    [
      "a payload whose message is not a string",
      { serialized: { kind: "conflict", message: 1 } },
    ],
    [
      "a payload whose kind is outside the union",
      { serialized: { kind: "not-a-kind", message: "x" } },
    ],
    [
      "a payload whose kind is not a string",
      { serialized: { kind: 1, code: "X", message: "x" } },
    ],
    [
      "a payload missing code",
      { serialized: { kind: "conflict", message: "x" } },
    ],
    [
      "a payload whose code is neither string nor null",
      { serialized: { kind: "conflict", code: {}, message: "x" } },
    ],
    [
      "a payload whose retryable is not a boolean",
      {
        serialized: {
          kind: "conflict",
          code: "X",
          message: "x",
          retryable: "yes",
        },
      },
    ],
    [
      "a validation payload whose fieldErrors is a string",
      {
        serialized: {
          kind: "validation",
          code: "X",
          message: "x",
          fieldErrors: "boom",
        },
      },
    ],
    [
      "a validation payload whose fieldErrors maps to a bare string",
      {
        serialized: {
          kind: "validation",
          code: "X",
          message: "x",
          fieldErrors: { email: "required" },
        },
      },
    ],
    [
      "a validation payload whose fieldErrors is an array",
      {
        serialized: {
          kind: "validation",
          code: "X",
          message: "x",
          fieldErrors: [],
        },
      },
    ],
  ];

  it.each(MALFORMED_PAYLOADS)(
    "returns false for a branded object with %s",
    (_label, shape) => {
      // `message` is present so every case here fails on the payload check
      // itself, not on the Error-shape check pinned above.
      const branded = {
        [APP_SERVER_ERROR_BRAND]: true,
        message: "x",
        ...shape,
      };

      expect(isAppServerError(branded)).toBe(false);
      // Answering `false` only matters if the value then lands somewhere safe:
      // every caller reads it back through `extractSerializedError`, whose last
      // stage fails closed onto the kind that maps to 500 and to redaction.
      expect(extractSerializedError(branded)).toEqual(UNVERIFIED_FALLBACK);
    },
  );
});

// The brand is a symbol-keyed own property, so it survives a module-graph
// split but not `structuredClone` / JSON / the RPC hop. Spreading a real
// `AppServerError` and cloning the result reproduces exactly what arrives on
// the far side: the `serialized` own property intact, the brand gone.
describe("after the brand was stripped by a serialization boundary", () => {
  const serialized = SAMPLES.conflict;

  const REMNANTS: ReadonlyArray<readonly [string, unknown]> = [
    ["structuredClone", structuredClone({ ...new AppServerError(serialized) })],
    [
      "a JSON roundtrip",
      JSON.parse(JSON.stringify({ ...new AppServerError(serialized) })),
    ],
  ];

  it.each(REMNANTS)(
    "is rejected by isAppServerError but still read by extractSerializedError after %s",
    (_label, remnant) => {
      expect(isAppServerError(remnant)).toBe(false);
      expect(extractSerializedError(remnant)).toEqual(serialized);
    },
  );

  // `isAppServerError` deliberately does not widen back to a `name` comparison
  // to cover the case above — the remnant stage of `extractSerializedError` is
  // the single receiver, and a forgeable `name` must not become an identity.
  it("keeps a name-only impostor out of the guard while the remnant stage still reads it", () => {
    const impostor = { name: "AppServerError", serialized };

    expect(isAppServerError(impostor)).toBe(false);
    expect(extractSerializedError(impostor)).toEqual(serialized);
  });
});

describe("extractSerializedError", () => {
  const serialized = serializeError(
    new ConflictError("EMAIL_ALREADY_REGISTERED", "test"),
  );

  it("extracts from an AppServerError", () => {
    const result = extractSerializedError(new AppServerError(serialized));
    expect(result).toEqual(serialized);
  });

  it("extracts from a plain object with a serialized remnant", () => {
    const result = extractSerializedError({ serialized });
    expect(result).toEqual(serialized);
  });

  // Holding the brand proves nothing about the payload: the serialization
  // adapter builds a genuine `AppServerError` out of any request body tagged
  // `$TSR/t/AppServerError`, so a branded instance goes through the same
  // rebuild an anonymous remnant does. Handing `error.serialized` on as-is
  // passes every `toEqual` on the known keys and still lets this one through.
  it("rebuilds a branded instance's payload instead of trusting it", () => {
    const forged = new AppServerError(
      fromTheWire({
        kind: "conflict",
        code: "EMAIL_ALREADY_REGISTERED",
        message: "Email already registered",
        evil: "pii",
      }),
    );

    expect(isAppServerError(forged)).toBe(true);

    const result = extractSerializedError(forged);

    expect(Object.keys(result)).toEqual(["kind", "code", "message"]);
    expect(JSON.stringify(redactForClient(result))).not.toContain("pii");
  });

  // Why the function can read the payload without consulting the brand at all:
  // the brand changes nothing about what comes back. Pinning it here is what
  // keeps a future "restore the branded fast path" from claiming a difference
  // that does not exist — and what would catch the reverse, a rebuild that
  // quietly starts depending on the brand.
  it.each([
    ["a well-formed payload", serialized],
    [
      "a payload carrying an undeclared key",
      fromTheWire({ ...serialized, evil: "pii" }),
    ],
    ["a payload outside the contract", fromTheWire({ kind: "conflict" })],
  ])("reads %s the same branded and unbranded", (_label, payload) => {
    const branded = { [APP_SERVER_ERROR_BRAND]: true, serialized: payload };

    expect(extractSerializedError(branded)).toEqual(
      extractSerializedError({ serialized: payload }),
    );
  });
});

describe("UNVERIFIED_SERIALIZED_ERROR", () => {
  it("is frozen, so a caller cannot mutate the shared fallback", () => {
    expect(Object.isFrozen(UNVERIFIED_SERIALIZED_ERROR)).toBe(true);
  });

  // It is handed out on both sides of the transport boundary — the inbound leg
  // of the serialization adapter never runs `redactForClient` — so the value
  // has to already be redacted for that asymmetry to be harmless.
  it("is already redacted, making redactForClient a no-op on it", () => {
    expect(redactForClient(UNVERIFIED_SERIALIZED_ERROR)).toEqual(
      UNVERIFIED_SERIALIZED_ERROR,
    );
  });
});
