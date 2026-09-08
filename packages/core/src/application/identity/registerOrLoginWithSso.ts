import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { Email, SsoProvider } from "@repo/core/domain/identity/valueObject";
import type { ServiceArgs } from "../types";
import { newCallerToken } from "./callerToken";
import { runSignupSaga } from "./signupSaga";

export type RegisterOrLoginWithSsoInput = Readonly<{
  provider: string;
  providerSubject: string;
  email: string;
}>;

export type RegisterOrLoginWithSsoOutput = Readonly<{
  userId: string;
  isNewUser: boolean;
}>;

/** `provider U+0000 subject`: the canonical of an SSO identity (`spec/database/index.md`). */
export function ssoCanonicalOf(
  provider: string,
  providerSubject: string,
): string {
  return `${provider}\u0000${providerSubject}`;
}

export function requireProviderSubject(providerSubject: string): string {
  const subject = providerSubject.trim();
  if (subject.length === 0) {
    throw new BusinessRuleError(
      IdentityErrorCode.UnsupportedSsoProvider,
      "The SSO subject must not be empty",
    );
  }
  return subject;
}

/**
 * S-AC-02. A known subject logs in with no write; an unknown one signs up
 * through the registration saga with two reservations — the subject (the
 * coordinator, usable for login) and the address (a uniqueness hold only,
 * `usableForLogin: false`). An address already held by any account is
 * never auto-linked: the second reservation loses, the first is handed
 * back, and the request ends in `EMAIL_ALREADY_REGISTERED`.
 */
export async function registerOrLoginWithSso({
  container,
  input,
}: ServiceArgs<RegisterOrLoginWithSsoInput>): Promise<RegisterOrLoginWithSsoOutput> {
  const provider = SsoProvider.create(input.provider);
  const providerSubject = requireProviderSubject(input.providerSubject);
  const email = Email.create(input.email);
  const gateway = container.identityGateway;

  const known = await gateway.resolveSsoIdentity(provider, providerSubject);
  if (known !== null && known.userId !== null) {
    return { userId: known.userId, isNewUser: false };
  }

  const userId = container.idGenerator.next();
  const ssoCredentialId = container.idGenerator.next();
  const emailCredentialId = container.idGenerator.next();
  const operationId = container.idGenerator.next();
  const callerToken = newCallerToken(container.tokenGenerator);
  const canonical = ssoCanonicalOf(provider, providerSubject);
  const ssoLocator = await gateway.deriveCredentialLocator(
    "sso",
    canonical,
    ssoCredentialId,
  );
  const emailLocator = await gateway.deriveCredentialLocator(
    "email",
    email,
    emailCredentialId,
  );

  await runSignupSaga(container, {
    userId,
    operationId,
    callerToken,
    credentials: [
      {
        locator: ssoLocator,
        credential: {
          credentialId: ssoCredentialId,
          kind: "sso",
          label: provider,
          usableForLogin: true,
        },
        canonical,
        passwordVerifier: null,
        conflictCode: "SSO_IDENTITY_ALREADY_REGISTERED",
      },
      {
        locator: emailLocator,
        credential: {
          credentialId: emailCredentialId,
          kind: "email",
          label: "",
          usableForLogin: false,
        },
        canonical: email,
        passwordVerifier: null,
        conflictCode: "EMAIL_ALREADY_REGISTERED",
      },
    ],
  });
  return { userId, isNewUser: true };
}
