import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import {
  type PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { createPbkdf2PasswordHasher } from "../pbkdf2PasswordHasher";

// Cheap enough for a unit suite; the format and the round trip do not depend
// on the cost parameter.
const ITERATIONS = 1000;
const hasher = createPbkdf2PasswordHasher({ iterations: ITERATIONS });
const PASSWORD = PlainPassword.create("correct-horse-battery");

const STORED_FORMAT =
  /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9+/=_-]+)\$([A-Za-z0-9+/=_-]+)$/;

describe("createPbkdf2PasswordHasher", () => {
  it("stores the verifier as pbkdf2-sha256$<iterations>$<salt>$<hash>", async () => {
    const hash = await hasher.hash(PASSWORD);
    const match = STORED_FORMAT.exec(hash);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(ITERATIONS);
    expect(hash).not.toContain("correct-horse-battery");
  });

  it("salts every derivation", async () => {
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);
    expect(first).not.toBe(second);
  });

  it("verifies its own output", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, hash)).resolves.toBe(true);
  });

  it("rejects a different password", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(
      hasher.verify(PlainPassword.create("correct-horse-battery!"), hash),
    ).resolves.toBe(false);
  });

  it("reads the cost parameter from the stored verifier, not its own", async () => {
    const stored = await createPbkdf2PasswordHasher({ iterations: 2000 }).hash(
      PASSWORD,
    );
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
  });

  it.each([
    ["an unknown algorithm", "argon2id$1000$c2FsdA$aGFzaA"],
    ["a non-numeric iteration count", "pbkdf2-sha256$many$c2FsdA$aGFzaA"],
    ["a zero iteration count", "pbkdf2-sha256$0$c2FsdA$aGFzaA"],
    ["a missing salt", "pbkdf2-sha256$1000$$aGFzaA"],
    ["a missing hash", "pbkdf2-sha256$1000$c2FsdA"],
    ["an opaque string", "not-a-hash"],
  ])(
    "reports a stored verifier with %s as DATA_INTEGRITY_ERROR",
    async (_label, stored) => {
      await expect(
        hasher.verify(PASSWORD, stored as PasswordHash),
      ).rejects.toSatisfy(
        (error) =>
          isSystemError(error) &&
          error.code === SystemErrorCode.DataIntegrityError,
      );
    },
  );
});
