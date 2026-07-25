import { describe, expect, it } from "vitest";
import { AUTH_FIELD_MAX_LENGTH, loginSchema, signupSchema } from "../schema";

// This boundary is deliberately *looser* than the domain: a 129-character
// password has to reach `PlainPassword` and come back as
// `IDENTITY_PASSWORD_TOO_WEAK`, not as a transport `validation` failure
// about a field the user cannot reason about. Encoding 128 (or 320) here
// would change which error the user sees without breaking a type, so the
// ceiling is pinned by test.
const schemas = [
  ["loginSchema", loginSchema],
  ["signupSchema", signupSchema],
] as const;

const email = (length: number) =>
  `${"a".repeat(length - "@example.com".length)}@example.com`;

describe.each(schemas)("%s", (_name, schema) => {
  it("accepts an address at the domain's own 320-character limit", () => {
    const value = email(320);
    expect(value).toHaveLength(320);
    expect(
      schema.safeParse({ email: value, password: "password123" }).success,
    ).toBe(true);
  });

  it("accepts a password at the domain's own 128-character limit", () => {
    const password = "p".repeat(128);
    expect(
      schema.safeParse({ email: "user@example.com", password }).success,
    ).toBe(true);
  });

  it("lets a password past the domain limit through to the domain", () => {
    const password = "p".repeat(129);
    expect(
      schema.safeParse({ email: "user@example.com", password }).success,
    ).toBe(true);
  });

  it("lets a 321-character address through to the domain", () => {
    expect(
      schema.safeParse({ email: email(321), password: "password123" }).success,
    ).toBe(true);
  });

  it.each([
    ["email", { email: "", password: "password123" }],
    ["password", { email: "user@example.com", password: "" }],
  ])("rejects an empty %s", (_field, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  // The one thing this boundary is for: keeping a multi-megabyte body
  // away from the key-derivation function.
  it.each([
    [
      "email",
      { email: email(AUTH_FIELD_MAX_LENGTH + 1), password: "password123" },
    ],
    [
      "password",
      {
        email: "user@example.com",
        password: "p".repeat(AUTH_FIELD_MAX_LENGTH + 1),
      },
    ],
  ])("rejects a %s over the DoS ceiling", (_field, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

it("keeps the DoS ceiling far above every domain limit", () => {
  expect(AUTH_FIELD_MAX_LENGTH).toBeGreaterThan(320);
});
