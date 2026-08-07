import {
  isApplicationError,
  isValidationError,
  ValidationError,
} from "@repo/core/application/errors";
import { isCodedError } from "@repo/core/lib/error";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractSerializedError,
  httpStatusFor,
  isAppServerError,
  type SerializedValidationError,
} from "../errorResponse";
import { InputValidationError, validateInput } from "../validator";

// Nested so the dotted-path flattening is exercised alongside a top-level key.
const schema = z.object({
  email: z.string().min(1, { message: "required" }),
  profile: z.object({ name: z.string().min(1, { message: "required" }) }),
});

const validate = validateInput(schema);

function captureFrom(input: unknown): unknown {
  try {
    validate(input);
  } catch (error) {
    return error;
  }
  throw new Error("expected validateInput to throw");
}

describe("validateInput", () => {
  it("returns the parsed value when the shape matches", () => {
    expect(
      validate({ email: "a@example.com", profile: { name: "A" } }),
    ).toEqual({ email: "a@example.com", profile: { name: "A" } });
  });

  // The transport boundary is the only place a shape failure is allowed to be
  // reported from, and it has to arrive as the same `validation` kind the
  // application layer uses — the auth forms read their wording off `code` and
  // the status mapping off `kind`.
  it("reports a shape failure as the validation kind and a 422", () => {
    const caught = captureFrom({ email: "", profile: { name: "" } });

    expect(isAppServerError(caught)).toBe(true);

    const serialized = extractSerializedError(caught);

    expect(serialized).toMatchObject({
      kind: "validation",
      code: "INVALID_INPUT",
      fieldErrors: {
        email: ["required"],
        "profile.name": ["required"],
      },
    });
    expect(httpStatusFor(serialized)).toBe(422);
  });

  // The thrown payload is what the client actually sees, so pinning that it
  // carries the same `kind` an application-layer `ValidationError` reports is
  // what keeps the two producers of `validation` interchangeable downstream.
  it("shares the discriminator isValidationError matches on", () => {
    const applicationFailure = new ValidationError("TEST", "test");

    expect(isValidationError(applicationFailure)).toBe(true);
    expect(extractSerializedError(captureFrom({})).kind).toBe(
      applicationFailure.serializedKind,
    );
  });
});

describe("InputValidationError", () => {
  // The guard match itself, not the thrown payload: a transport-shape failure
  // that reports `kind: "validation"` on the wire (HTTP 422) but misses
  // `isValidationError` is the regression this pins.
  it("is matched by isValidationError", () => {
    const error = new InputValidationError({ email: ["required"] });

    expect(isValidationError(error)).toBe(true);
    // Reached through the guard so its structural return type — not the
    // concrete class — is what supplies `toSerialized`. The annotation is the
    // assertion: narrowing that hands back the base `{ kind: string }` payload
    // still satisfies every `toEqual` below, so only a compile error catches
    // it.
    if (!isValidationError(error)) throw new Error("unreachable");
    const serialized: SerializedValidationError = error.toSerialized();
    expect(serialized).toEqual({
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      retryable: false,
      fieldErrors: { email: ["required"] },
    });
  });

  // The counterweight: sharing a `serializedKind` with the application layer
  // must not make a presentation-layer error an `ApplicationError`. That guard
  // matches a brand of its own, which `CodedError` subclasses outside the
  // application layer do not carry.
  it("is a CodedError but not an ApplicationError", () => {
    const error = new InputValidationError({});

    expect(isCodedError(error)).toBe(true);
    expect(isApplicationError(error)).toBe(false);
  });

  // `serializedKind` and `toSerialized().kind` are written independently, so a
  // drift between them would make the guard and the HTTP status disagree.
  it("reports a serializedKind that matches its serialized payload", () => {
    const error = new InputValidationError({});

    expect(error.serializedKind).toBe(error.toSerialized().kind);
    expect(httpStatusFor(error.toSerialized())).toBe(422);
  });
});
