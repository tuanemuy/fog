/**
 * Mints opaque secrets — caller bindings, reset tokens, authorization-code
 * `jti`s. Every value carries at least 128 bits from a cryptographic random
 * source and is never derived from time, a counter or an id; the encoding
 * (hex or base64url) is the adapter's, and callers treat the string as
 * opaque. Behind a port so that domain and application code stay
 * deterministic in tests.
 */
export interface TokenGenerator {
  next(): string;
}

/** The shortest value any adapter may produce: 128 bits in hex. */
export const TOKEN_MIN_LENGTH = 32;
