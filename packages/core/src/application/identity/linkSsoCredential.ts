import { User } from "@repo/core/domain/identity/entity";
import { SsoProvider } from "@repo/core/domain/identity/valueObject";
import { ConflictError, isConflictError, NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { BeginLinkDto, CompleteLinkDto } from "./gateway";
import { resumeLinkOperationKey } from "./jobKeys";
import { toCredentialLocator } from "./rebuild";
import {
  requireProviderSubject,
  ssoCanonicalOf,
} from "./registerOrLoginWithSso";
import { INITIAL_CREDENTIAL_VERSION, mappingOf } from "./signupSaga";

export type LinkSsoCredentialInput = Readonly<{
  userId: string;
  provider: string;
  providerSubject: string;
}>;

export type LinkSsoCredentialOutput = Readonly<{ credentialId: string }>;

function alreadyRegistered(): ConflictError {
  return new ConflictError(
    "SSO_IDENTITY_ALREADY_REGISTERED",
    "This SSO identity is already registered",
  );
}

/**
 * S-AC-02 edge (P-13): record the procedure and its `resume-link` first,
 * reserve the subject in the bucket, activate it, then add the credential
 * with its reverse-index row and close the record. A reservation lost
 * closes the record at once (nothing to roll back). The session epoch
 * does not move.
 */
export async function linkSsoCredential({
  container,
  input,
}: ServiceArgs<LinkSsoCredentialInput>): Promise<LinkSsoCredentialOutput> {
  const provider = SsoProvider.create(input.provider);
  const providerSubject = requireProviderSubject(input.providerSubject);
  const gateway = container.identityGateway;
  const credentialId = container.idGenerator.next();
  const operationId = container.idGenerator.next();
  const canonical = ssoCanonicalOf(provider, providerSubject);
  const locator = await gateway.deriveCredentialLocator(
    "sso",
    canonical,
    credentialId,
  );

  const { callerToken } = await gateway.beginLink(input.userId, {
    operationId,
    credentialId,
    locator,
    label: provider,
  });
  try {
    await gateway.reserveCredential(locator, {
      saga: "link",
      operationId,
      candidateUserId: input.userId,
      callerToken,
      canonical,
      passwordVerifier: null,
      reservedUntil: new Date(
        container.clock.now().getTime() +
          container.identityTuning.reservationTtlMs,
      ),
      coordinator: { role: "coordinator", locators: [locator] },
    });
  } catch (error) {
    await gateway.finishLink(input.userId, { operationId });
    throw isConflictError(error) ? alreadyRegistered() : error;
  }
  const activated = await gateway.activateReservation(
    locator,
    operationId,
    input.userId,
  );
  if (!activated) {
    await gateway.finishLink(input.userId, { operationId });
    throw alreadyRegistered();
  }
  await gateway.completeLink(input.userId, {
    operationId,
    locator: {
      credentialId,
      kind: "sso",
      mapping: mappingOf(locator),
      credentialVersion: INITIAL_CREDENTIAL_VERSION,
      usableForLogin: true,
      label: provider,
    },
  });
  return { credentialId };
}

/** Inside the User Data DO: the record of the procedure and the job that forwards it. */
export function beginLinkProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: BeginLinkDto,
  resumeAt: Date,
): void {
  if (ctx.userSettingsRepository.find() === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }
  ctx.recordOperation({
    operationId: dto.operationId,
    kind: "link",
    payload: { credentialId: dto.credentialId, locator: dto.locator },
    phase: "reserving",
    targetLocators: [{ ...dto.locator, label: dto.label }],
  });
  ctx.enqueueJob({
    operationKey: resumeLinkOperationKey(dto.operationId),
    kind: "resume-link",
    payload: { operationId: dto.operationId },
    nextRunAt: resumeAt,
  });
}

/** Inside the User Data DO: the credential joins the set, the reverse index learns it, the record closes. Idempotent. */
export function completeLinkProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: CompleteLinkDto,
  now: Date,
): void {
  const found = ctx.userSettingsRepository.find();
  if (found === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }
  const locator = toCredentialLocator(dto.locator);
  if (
    !found.entity.credentials.some(
      (c) => c.credentialId === locator.credentialId,
    )
  ) {
    const user = User.addCredential(
      found.entity,
      {
        credentialId: locator.credentialId,
        kind: "sso",
        label: locator.label,
        usableForLogin: true,
      },
      now,
    );
    ctx.userSettingsRepository.save(user, found.expectedVersion);
  }
  ctx.credentialLocatorStore.record(locator);
  ctx.updateOperation({ operationId: dto.operationId, phase: "done" });
}

export function finishLinkProcedure(
  ctx: UserDataUnitOfWorkContext,
  operationId: string,
): void {
  ctx.updateOperation({ operationId, phase: "done" });
}
