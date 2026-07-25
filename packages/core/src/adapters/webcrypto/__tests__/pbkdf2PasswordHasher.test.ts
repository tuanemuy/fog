import { isSystemError } from "@repo/core/application/errors";
import {
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import {
  createPbkdf2PasswordHasher,
  DEFAULT_PBKDF2_ITERATIONS,
} from "../pbkdf2PasswordHasher";

// Production strength is 210k iterations; the tests run at a cost the
// runner can afford, which is exactly what the factory argument exists
// for. The parameters, not the cost, are what these assertions pin.
const ITERATIONS = 1_000;
const hasher = createPbkdf2PasswordHasher({ iterations: ITERATIONS });

const PASSWORD = PlainPassword.create("password123");

describe("createPbkdf2PasswordHasher", () => {
  it("verifies a password it hashed", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, hash)).resolves.toBe(true);
  });

  it("reports a wrong password as false rather than throwing", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(
      hasher.verify(PlainPassword.create("password124"), hash),
    ).resolves.toBe(false);
  });

  it("treats a password differing only in whitespace as wrong", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(
      hasher.verify(PlainPassword.create(" password123"), hash),
    ).resolves.toBe(false);
  });

  it("encodes algorithm, iterations, salt and derived key", async () => {
    const hash = await hasher.hash(PASSWORD);
    const [algorithm, iterations, salt, derived] = hash.split("$");

    expect(algorithm).toBe("pbkdf2-sha256");
    expect(iterations).toBe(String(ITERATIONS));
    // 16-byte salt and a 256-bit derived key, base64-encoded.
    expect(atob(salt ?? "")).toHaveLength(16);
    expect(atob(derived ?? "")).toHaveLength(32);
  });

  it("draws a fresh salt per call, so the same password hashes differently", async () => {
    const [first, second] = await Promise.all([
      hasher.hash(PASSWORD),
      hasher.hash(PASSWORD),
    ]);

    expect(first).not.toBe(second);
    expect(first.split("$")[2]).not.toBe(second.split("$")[2]);
    await expect(hasher.verify(PASSWORD, first)).resolves.toBe(true);
    await expect(hasher.verify(PASSWORD, second)).resolves.toBe(true);
  });

  it("reads the iteration count back from the stored hash rather than its own setting", async () => {
    const weak = createPbkdf2PasswordHasher({ iterations: 500 });
    const strong = createPbkdf2PasswordHasher({ iterations: 2_000 });

    const weakHash = await weak.hash(PASSWORD);
    const strongHash = await strong.hash(PASSWORD);

    expect(weakHash.split("$")[1]).toBe("500");
    expect(strongHash.split("$")[1]).toBe("2000");
    // Raising the cost must not invalidate hashes made at the old one.
    await expect(strong.verify(PASSWORD, weakHash)).resolves.toBe(true);
    await expect(weak.verify(PASSWORD, strongHash)).resolves.toBe(true);
  });

  it("defaults to the OWASP iteration count", () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000);
  });

  it.each([
    ["wrong field count", "pbkdf2-sha256$1000$c2FsdA=="],
    ["unknown algorithm", "argon2id$1000$c2FsdA==$aGFzaA=="],
    ["non-numeric iterations", "pbkdf2-sha256$many$c2FsdA==$aGFzaA=="],
    ["zero iterations", "pbkdf2-sha256$0$c2FsdA==$aGFzaA=="],
    ["malformed base64", "pbkdf2-sha256$1000$!!!$aGFzaA=="],
  ])(
    "raises SystemError(DATA_INTEGRITY_ERROR) for a stored hash it cannot read: %s",
    async (_label, stored) => {
      let caught: unknown;
      try {
        await hasher.verify(PASSWORD, PasswordHash.create(stored));
      } catch (error) {
        caught = error;
      }

      expect(isSystemError(caught)).toBe(true);
      expect(isSystemError(caught) && caught.code).toBe("DATA_INTEGRITY_ERROR");
    },
  );
});
