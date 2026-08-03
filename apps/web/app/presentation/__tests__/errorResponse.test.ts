import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  UnauthorizedError,
  ValidationError,
} from "@repo/core/application/errors";
import { RESTORABLE_ERROR_KINDS } from "@repo/core/application/rpc/restoreError";
import { BusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  httpStatusFor,
  redactForClient,
  redactsMessage,
  SERIALIZED_ERROR_KINDS,
  type SerializedError,
  type SerializedErrorKind,
  serializeError,
} from "../errorResponse";

// Shaped like the strings that actually leak on the DO stack: a SQLite error
// code, a table name, and an absolute server path.
const INTERNAL_DETAIL =
  "SQLITE_ERROR: no such table: user_settings (/var/task/packages/core/adapters/cloudflare/userData/userSettingsRepository.js:120)";

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

const REDACTED_KINDS = [
  "system",
  "unknown",
] as const satisfies ReadonlyArray<SerializedErrorKind>;

// Kinds the UI renders from `code` alone: the code survives, the free-form
// server message does not.
const MESSAGE_ONLY_REDACTED_KINDS = [
  "notFound",
  "conflict",
  "unauthorized",
  "forbidden",
] as const satisfies ReadonlyArray<SerializedErrorKind>;

const PASSED_THROUGH_KINDS = KINDS.filter(
  (kind) =>
    !REDACTED_KINDS.some((redacted) => redacted === kind) &&
    !MESSAGE_ONLY_REDACTED_KINDS.some((redacted) => redacted === kind),
);

describe("serializeError", () => {
  it.each(KINDS)("projects the %s sample onto that kind", (kind) => {
    expect(SAMPLES[kind].kind).toBe(kind);
  });
});

// The transport boundary logs whatever this reports as dropped, so the two
// have to stay in step: a kind that redaction blanks while `redactsMessage`
// says otherwise loses its message on the wire *and* in the log.
describe("redactsMessage", () => {
  it.each(KINDS)("agrees with what redaction does to %s", (kind) => {
    const sample = SAMPLES[kind];

    expect(redactsMessage(kind)).toBe(
      redactForClient(sample).message !== sample.message,
    );
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

  it.each(MESSAGE_ONLY_REDACTED_KINDS)(
    "keeps the code of %s but drops its server message",
    (kind) => {
      const redacted = redactForClient(SAMPLES[kind]);

      expect(redacted.code).toBe(SAMPLES[kind].code);
      expect(redacted.message).toBe("Request failed");
    },
  );

  // The leak this closes: a job-table conflict interpolates the job's
  // `operationKey` into its message, and for `send-mail` that key is derived
  // from an HMAC.
  it("drops a server-minted key carried in a conflict message", () => {
    const operationKey = "send-mail:9f2c1d0e8a7b6c5d4e3f2a1b0c9d8e7f";
    const redacted = redactForClient(
      serializeError(
        new ConflictError(
          "JOB_PAYLOAD_MISMATCH",
          `Job ${operationKey} exists with a different payload`,
        ),
      ),
    );

    expect(JSON.stringify(redacted)).not.toContain(operationKey);
    expect(redacted.code).toBe("JOB_PAYLOAD_MISMATCH");
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

    expect(wire).not.toContain("SQLITE_ERROR");
    expect(wire).not.toContain("user_settings");
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

// The `SerializedError` union is assembled here, so this is where the RPC
// restoration table is pinned against it. `unknown` is presentation-only —
// no Durable Object envelope ever carries it — so the restoration table is
// the union minus that one variant.
describe("RPC restoration table", () => {
  it("covers every serialized kind except presentation-only `unknown`", () => {
    expect([...RESTORABLE_ERROR_KINDS, "unknown"].sort()).toEqual(
      Object.keys(SERIALIZED_ERROR_KINDS).sort(),
    );
  });
});
