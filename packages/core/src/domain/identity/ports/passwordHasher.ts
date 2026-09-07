import type { PasswordHash, PlainPassword } from "../valueObject";

/**
 * One of the two asynchronous ports (`spec/domains/index.md`). Hashing runs
 * before a unit of work opens and verification runs outside the Durable
 * Object; neither ever sits inside a transaction.
 */
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
}
