import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { SecretCrypto } from "@repo/core/application/fog/ports";

export function createBoundedSecretCrypto(
  crypto: SecretCrypto,
  { maxQueued = 2 }: { maxQueued?: number } = {},
): SecretCrypto {
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0)
    throw new RangeError("maxQueued must be a non-negative safe integer");

  let active = false;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (!active) {
      active = true;
      return;
    }
    if (queue.length >= maxQueued)
      throw new SystemError(
        SystemErrorCode.CapacityExceeded,
        "Password processing is busy. Try again shortly.",
      );
    await new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active = false;
  };
  const admitted = async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    dummyPasswordHash: crypto.dummyPasswordHash,
    hashPassword: (password) => admitted(() => crypto.hashPassword(password)),
    verifyPassword: (password, hash) =>
      admitted(() => crypto.verifyPassword(password, hash)),
    newToken: () => crypto.newToken(),
    digestToken: (token) => crypto.digestToken(token),
    pkceChallenge: (verifier) => crypto.pkceChallenge(verifier),
  };
}
