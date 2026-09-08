import { Email, PlainPassword } from "@repo/core/domain/identity/valueObject";
import type { ServiceArgs } from "../types";
import { newCallerToken } from "./callerToken";
import { runSignupSaga } from "./signupSaga";

export { INITIAL_CREDENTIAL_VERSION } from "./signupSaga";

export type RegisterWithPasswordInput = Readonly<{
  email: string;
  password: string;
}>;

export type RegisterWithPasswordOutput = Readonly<{ userId: string }>;

/** S-AC-01: one email credential, reserved and activated through the registration saga (`signupSaga.ts`). */
export async function registerWithPassword({
  container,
  input,
}: ServiceArgs<RegisterWithPasswordInput>): Promise<RegisterWithPasswordOutput> {
  const userId = container.idGenerator.next();
  const credentialId = container.idGenerator.next();
  const operationId = container.idGenerator.next();
  const callerToken = newCallerToken(container.tokenGenerator);

  const email = Email.create(input.email);
  const password = PlainPassword.create(input.password);
  const verifier = await container.passwordHasher.hash(password);

  const locator = await container.identityGateway.deriveCredentialLocator(
    "email",
    email,
    credentialId,
  );
  await runSignupSaga(container, {
    userId,
    operationId,
    callerToken,
    credentials: [
      {
        locator,
        credential: {
          credentialId,
          kind: "email",
          label: "",
          usableForLogin: true,
        },
        canonical: email,
        passwordVerifier: verifier,
        conflictCode: "EMAIL_ALREADY_REGISTERED",
      },
    ],
  });
  return { userId };
}
