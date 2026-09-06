import { describe, expect, it } from "vitest";
import { createBoundedSecretCrypto } from "../boundedCrypto";
import { nodeSecretCrypto } from "../crypto";

describe("Workers password KDF admission", () => {
  it("hashes, verifies, rejects invalid passwords, and uses a fixed valid dummy hash", async () => {
    const crypto = createBoundedSecretCrypto(nodeSecretCrypto);
    const hash = await crypto.hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    await expect(
      crypto.verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
    await expect(crypto.verifyPassword("invalid", hash)).resolves.toBe(false);
    await expect(
      crypto.verifyPassword("anything", "not-a-password-hash"),
    ).resolves.toBe(false);
    await expect(
      crypto.verifyPassword(
        "fog-fixed-dummy-password",
        crypto.dummyPasswordHash,
      ),
    ).resolves.toBe(true);
  });

  it("serializes three concurrent KDFs and rejects work beyond its bounded queue", async () => {
    const crypto = createBoundedSecretCrypto(nodeSecretCrypto, {
      maxQueued: 2,
    });
    const accepted = ["one", "two", "three"].map((value) =>
      crypto.hashPassword(value),
    );
    await expect(crypto.hashPassword("overload")).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
      retryable: true,
    });
    const hashes = await Promise.all(accepted);
    expect(new Set(hashes).size).toBe(3);
  });

  it("admits exactly one KDF operation at a time", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const crypto = createBoundedSecretCrypto({
      ...nodeSecretCrypto,
      hashPassword: async (password) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return password;
      },
    });
    const pending = ["one", "two", "three"].map((value) =>
      crypto.hashPassword(value),
    );
    await Promise.resolve();
    expect(active).toBe(1);
    for (let index = 0; index < 3; index++) {
      releases[index]?.();
      await expect(pending[index]).resolves.toBe(
        ["one", "two", "three"][index],
      );
      await Promise.resolve();
    }
    await expect(Promise.all(pending)).resolves.toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(maximum).toBe(1);
  });
});
