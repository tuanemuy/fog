import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { SecretCrypto } from "@repo/core/application/fog/ports";

const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

export const nodeSecretCrypto: SecretCrypto = {
  async hashPassword(password) {
    const salt = randomBytes(32).toString("hex");
    const hash = await derive(password, salt);
    return `scrypt$32768$8$3$${salt}$${hash.toString("hex")}`;
  },
  async verifyPassword(password, encoded) {
    const parts = encoded.split("$");
    const salt = parts[4];
    const expected = parts[5];
    if (
      parts.length !== 6 ||
      parts[0] !== "scrypt" ||
      parts[1] !== "32768" ||
      parts[2] !== "8" ||
      parts[3] !== "3" ||
      !salt ||
      !expected ||
      !/^[a-f0-9]{64}$/.test(salt) ||
      !/^[a-f0-9]{128}$/.test(expected)
    )
      return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  },
  newToken: () => randomBytes(32).toString("base64url"),
  pkceChallenge: (verifier) =>
    createHash("sha256").update(verifier).digest("base64url"),
  digestToken: (token) => createHash("sha256").update(token).digest("hex"),
};
