import { Email, PlainPassword } from "@repo/core/domain/identity/valueObject";
import type { ServiceArgs } from "../types";
import { runSignupSaga } from "./signupSaga";

export type RegisterWithPasswordInput = {
  email: string;
  password: string;
};

export type RegisterWithPasswordOutput = {
  userId: string;
  sessionEpoch: number;
};

/**
 * Registers a password account.
 *
 * An already-registered address is rejected outright rather than linked to the
 * existing account, whatever its auth method — silently merging identities is
 * how account-takeover bugs start.
 *
 * The hash is computed here, before any Durable Object is touched: key
 * derivation is deliberately slow, and a single-threaded DO must not be
 * occupied for its duration.
 *
 * **No `catch` translating unique-constraint violations.** With a synchronous
 * commit the violation is raised in the adapter's own frame, so
 * `createCredentialMappingStore` translates it — which is where it belonged all
 * along. The old comment here conceded the translation was only safe given what
 * that one unit of work happened to write.
 */
export async function registerWithPassword({
  container,
  input,
}: ServiceArgs<RegisterWithPasswordInput>): Promise<RegisterWithPasswordOutput> {
  const email = Email.create(input.email);
  const plainPassword = PlainPassword.create(input.password);
  const passwordHash = await container.passwordHasher.hash(plainPassword);

  return runSignupSaga(container, [
    {
      kind: "email",
      canonical: email,
      // Non-PII by contract: an email credential's label is the empty string,
      // never the address.
      label: "",
      passwordVerifier: passwordHash,
    },
  ]);
}
