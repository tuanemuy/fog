import type { TokenGenerator } from "@repo/core/application/ports/tokenGenerator";

const TOKEN_BYTES = 16;

/** 128 bits from `crypto.getRandomValues`, hex-encoded (32 characters). */
export const WebCryptoTokenGenerator: TokenGenerator = {
  next: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  },
};
