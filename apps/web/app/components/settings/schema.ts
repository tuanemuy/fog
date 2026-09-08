import { z } from "zod";
import { isRecord } from "@/presentation/serverFnResult";

/** Transport bound only (DoS); the domain has no upper bound (decision △-4). */
export const changeTrashRetentionDaysSchema = z.object({
  retentionDays: z.number().int().min(1).max(36_500),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

export const unlinkSsoCredentialSchema = z.object({
  credentialId: z.string().min(1).max(128),
});

export type PasswordChangedResult = Readonly<{ ok: true }>;
export function isPasswordChangedResult(
  value: unknown,
): value is PasswordChangedResult {
  return isRecord(value) && value.ok === true;
}

export type CredentialUnlinkedResult = Readonly<{ credentialId: string }>;
export function isCredentialUnlinkedResult(
  value: unknown,
): value is CredentialUnlinkedResult {
  return isRecord(value) && typeof value.credentialId === "string";
}

export type ConnectionsRevokedResult = Readonly<{ revokedCount: number }>;
export function isConnectionsRevokedResult(
  value: unknown,
): value is ConnectionsRevokedResult {
  return isRecord(value) && typeof value.revokedCount === "number";
}

export type RetentionSavedResult = Readonly<{ retentionDays: number }>;
export function isRetentionSavedResult(
  value: unknown,
): value is RetentionSavedResult {
  return isRecord(value) && typeof value.retentionDays === "number";
}
