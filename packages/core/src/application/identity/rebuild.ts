import type { CredentialLocator } from "@repo/core/domain/identity/ports/credentialLocatorStore";
import type { CredentialCoordinate } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import type { CredentialCoordinateDto, CredentialLocatorDto } from "./gateway";

/** The value-object reconstruction of a locator that crossed the DO boundary. */
export function toCredentialLocator(
  dto: CredentialLocatorDto,
): CredentialLocator {
  return {
    credentialId: CredentialId.create(dto.credentialId),
    kind: dto.kind,
    mapping: dto.mapping,
    credentialVersion: dto.credentialVersion,
    usableForLogin: dto.usableForLogin,
    label: dto.label,
  };
}

export function toCredentialCoordinate(
  dto: CredentialCoordinateDto,
): CredentialCoordinate {
  return {
    credentialId: CredentialId.create(dto.credentialId),
    kind: dto.kind,
    mapping: dto.mapping,
  };
}

export function fromCredentialLocator(
  locator: CredentialLocator,
): CredentialLocatorDto {
  return {
    credentialId: locator.credentialId,
    kind: locator.kind,
    mapping: locator.mapping,
    credentialVersion: locator.credentialVersion,
    usableForLogin: locator.usableForLogin,
    label: locator.label,
  };
}
