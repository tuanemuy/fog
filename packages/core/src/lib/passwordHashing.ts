/**
 * The PBKDF2 work factor, held here because two layers need the same number
 * and neither may import the other.
 *
 * `loginWithPassword` (application) levels its response time by verifying a
 * dummy hash that declares this cost; `pbkdf2PasswordHasher` (adapters) types
 * its `DEFAULT_PBKDF2_ITERATIONS` as `typeof` this constant so the two cannot
 * drift. Before it moved here the adapter imported the application module,
 * which is the reversed dependency AC-25 forbids.
 *
 * An import-free leaf: `lib/` is what every layer may depend on.
 */
export const DUMMY_PASSWORD_HASH_ITERATIONS = 210_000;
