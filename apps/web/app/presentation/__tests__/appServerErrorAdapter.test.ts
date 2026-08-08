import { describe, expect, it } from "vitest";
import { startInstance } from "@/start";
import { appServerErrorAdapter } from "../appServerErrorAdapter";
import {
  AppServerError,
  extractSerializedError,
  isAppServerError,
  type SerializedError,
  type SerializedErrorKind,
  UNVERIFIED_SERIALIZED_ERROR,
} from "../errorResponse";

const invalidCredentials: SerializedError = {
  kind: "validation",
  code: "INVALID_CREDENTIALS",
  message: "Invalid email or password",
  retryable: false,
};

// `fromSerializable` is typed against `SerializedError`, but the values it
// actually receives are Seroval nodes parsed out of a request body. The cast
// stands in for that gap so the tests below can hand it the shapes a client
// can post.
function fromTheWire(value: Record<string, unknown>): SerializedError {
  return value as unknown as SerializedError;
}

// Server functions are compiled into their own module graph while the
// serialization adapter is loaded from the SSR graph, so one process holds
// two distinct `AppServerError` classes built from this same file. The `?dup`
// query gives Vite a second module instance, which reproduces that split
// without needing the full dev server.
async function loadForeignGraph(): Promise<typeof import("../errorResponse")> {
  const specifier = "../errorResponse.ts?dup";
  return import(/* @vite-ignore */ specifier);
}

describe("appServerErrorAdapter", () => {
  it("is registered on the start instance", async () => {
    const options = await startInstance.getOptions();
    expect(options.serializationAdapters).toContain(appServerErrorAdapter);
  });

  it("carries kind and code across the roundtrip", () => {
    const error = new AppServerError(invalidCredentials);

    expect(appServerErrorAdapter.test(error)).toBe(true);
    const revived = appServerErrorAdapter.fromSerializable(
      appServerErrorAdapter.toSerializable(error),
    );

    expect(revived.serialized).toEqual(invalidCredentials);
  });

  it("matches an AppServerError thrown from another module graph", async () => {
    const foreign = await loadForeignGraph();
    expect(foreign.AppServerError).not.toBe(AppServerError);

    const error = new foreign.AppServerError(invalidCredentials);
    // biome-ignore lint/plugin: negative control — this false is the failure mode `isAppServerError` exists to replace, and the adapter silently dropping `kind` is what it caused
    expect(error instanceof AppServerError).toBe(false);
    expect(isAppServerError(error)).toBe(true);

    expect(appServerErrorAdapter.test(error)).toBe(true);
    expect(appServerErrorAdapter.toSerializable(error)).toEqual(
      invalidCredentials,
    );
  });

  // The counterweight to the two `fromSerializable` tables below: verification
  // that rejects too much is a silent outage on the outbound leg, where every
  // one of these is a payload a usecase legitimately produced. Typed as a
  // total record so a new member of the union fails to compile here until it
  // gets a roundtrip sample — including the ones that carry an optional key.
  const ROUNDTRIP_SAMPLES_BY_KIND = {
    business: {
      kind: "business",
      code: "IDENTITY_EMAIL_TOO_LONG",
      message: "Email is too long",
      retryable: false,
    },
    notFound: {
      kind: "notFound",
      code: "USER_NOT_FOUND",
      message: "No such user",
      retryable: false,
    },
    conflict: {
      kind: "conflict",
      code: "EMAIL_ALREADY_REGISTERED",
      message: "Email already registered",
      retryable: false,
    },
    unauthorized: {
      kind: "unauthorized",
      code: "SESSION_REQUIRED",
      message: "Sign in required",
      retryable: false,
    },
    forbidden: {
      kind: "forbidden",
      code: "NOT_RESOURCE_OWNER",
      message: "Not the owner",
      retryable: false,
    },
    validation: {
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
      retryable: false,
      fieldErrors: { email: ["Invalid email or password"] },
    },
    system: {
      kind: "system",
      code: "DATABASE_ERROR",
      message: "Database unavailable",
      retryable: true,
    },
    unknown: { kind: "unknown", code: null, message: "Unexpected error" },
  } as const satisfies Record<SerializedErrorKind, SerializedError>;

  const ROUNDTRIP_SAMPLES = Object.values(ROUNDTRIP_SAMPLES_BY_KIND);

  // The half the `satisfies` cannot hold: the record type ties the key set to
  // the union but not each sample to its key, so a sample filed under the
  // wrong kind would silently shrink the roundtrip coverage.
  it("keys each roundtrip sample by its own kind", () => {
    for (const [kind, sample] of Object.entries(ROUNDTRIP_SAMPLES_BY_KIND)) {
      expect(sample.kind).toBe(kind);
    }
  });

  it.each(ROUNDTRIP_SAMPLES)(
    "carries a $kind payload through the roundtrip unchanged",
    (sample) => {
      const wire = appServerErrorAdapter.toSerializable(
        new AppServerError(sample),
      );

      expect(wire).toEqual(sample);

      const revived = appServerErrorAdapter.fromSerializable(wire);

      expect(revived.serialized).toEqual(sample);
      expect(revived.serialized).not.toBe(UNVERIFIED_SERIALIZED_ERROR);
    },
  );

  // `test` validates the payload but does not minimize it: a hand-built
  // `AppServerError` carrying an undeclared key passes `test`, so the outbound
  // leg must rebuild rather than rely on every construction site handing it a
  // clean payload. Handing `value.serialized` on as-is satisfies every
  // `toEqual` above and still fails this.
  it("rebuilds an outbound payload from the known keys only", () => {
    const error = new AppServerError(
      fromTheWire({
        kind: "conflict",
        code: "EMAIL_ALREADY_REGISTERED",
        message: "Email already registered",
        evil: "pii",
      }),
    );

    expect(appServerErrorAdapter.test(error)).toBe(true);

    const wire = appServerErrorAdapter.toSerializable(error);

    expect(Object.keys(wire)).toEqual(["kind", "code", "message"]);
    expect(JSON.stringify(wire)).not.toContain("pii");
  });

  // Unreachable while `test` gates the outbound leg — it rejects a payload that
  // fails `asSerializedError` — but the fallback is what keeps the guarantee
  // structural rather than an invariant spanning two functions, so it is
  // pinned here.
  it("falls closed on the outbound leg for a payload test would reject", () => {
    const error = new AppServerError(
      fromTheWire({ kind: "not-a-kind", message: "x" }),
    );

    expect(appServerErrorAdapter.test(error)).toBe(false);
    expect(appServerErrorAdapter.toSerializable(error)).toBe(
      UNVERIFIED_SERIALIZED_ERROR,
    );
  });

  // The inbound leg has no `test` to lean on, so `fromSerializable` is the only
  // place a client-posted node is checked. Rebuilding — not merely accepting —
  // is what this pins: returning the node as-is satisfies a `toEqual` on the
  // known keys and still lets the extra one through to `redactForClient`.
  it("rebuilds an inbound payload from the known keys only", () => {
    const revived = appServerErrorAdapter.fromSerializable(
      fromTheWire({
        kind: "conflict",
        code: "EMAIL_ALREADY_REGISTERED",
        message: "Email already registered",
        evil: "pii",
      }),
    );

    expect(Object.keys(revived.serialized)).toEqual([
      "kind",
      "code",
      "message",
    ]);
    expect(JSON.stringify(revived.serialized)).not.toContain("pii");
  });

  // Failing closed rather than throwing: a throw here aborts the whole payload
  // parse, which on the outbound leg turns one unrepresentable error into a
  // client-side parse failure.
  const FORGED_PAYLOADS: ReadonlyArray<
    readonly [string, Record<string, unknown>]
  > = [
    [
      "a kind outside the union",
      { kind: "not-a-kind", code: null, message: "x" },
    ],
    ["a kind that is not a string", { kind: 1, code: null, message: "x" }],
    ["no code at all", { kind: "conflict", message: "x" }],
    [
      "a code that is neither string nor null",
      { kind: "conflict", code: {}, message: "x" },
    ],
    [
      "a message that is not a string",
      { kind: "conflict", code: null, message: 1 },
    ],
    [
      "a retryable that is not a boolean",
      { kind: "conflict", code: null, message: "x", retryable: "yes" },
    ],
    [
      "fieldErrors that are not a record",
      { kind: "validation", code: null, message: "x", fieldErrors: "boom" },
    ],
    [
      "fieldErrors whose values are not string arrays",
      {
        kind: "validation",
        code: null,
        message: "x",
        fieldErrors: { email: [1] },
      },
    ],
  ];

  it.each(FORGED_PAYLOADS)(
    "falls closed to the unverified fallback for %s",
    (_label, payload) => {
      const revived = appServerErrorAdapter.fromSerializable(
        fromTheWire(payload),
      );

      expect(revived.serialized).toBe(UNVERIFIED_SERIALIZED_ERROR);
    },
  );

  it("ignores errors that carry no serialized payload", () => {
    expect(appServerErrorAdapter.test(new Error("boom"))).toBe(false);
    expect(appServerErrorAdapter.test({ name: "AppServerError" })).toBe(false);
    expect(
      appServerErrorAdapter.test({
        name: "AppServerError",
        serialized: { kind: "not-a-kind", message: "x" },
      }),
    ).toBe(false);
  });
});

describe("extractSerializedError", () => {
  it("recovers kind and code from a foreign-graph AppServerError", async () => {
    const foreign = await loadForeignGraph();
    const error = new foreign.AppServerError(invalidCredentials);

    expect(isAppServerError(error)).toBe(true);
    expect(extractSerializedError(error)).toEqual(invalidCredentials);
  });

  it("recovers kind and code when the adapter was bypassed entirely", () => {
    expect(
      extractSerializedError({ name: "Error", serialized: invalidCredentials }),
    ).toEqual(invalidCredentials);
  });

  it("falls back to unknown for a plain error", () => {
    expect(extractSerializedError(new Error("boom"))).toEqual({
      kind: "unknown",
      code: null,
      message: "boom",
    });
  });
});
