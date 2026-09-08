import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { Actor } from "@repo/core/domain/identity/valueObject";

export type CredentialView = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  label: string;
  usableForLogin: boolean;
}>;

/** S-AC-06's row; `revokedAt` is non-null exactly when `status` is `"revoked"`. */
export type AiClientConnectionView = Readonly<{
  connectionId: string;
  clientName: string;
  status: "active" | "revoked";
  connectedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}>;

export type CurrentUserView = Readonly<{
  userId: string;
  email: string;
  credentials: readonly CredentialView[];
  trashRetentionDays: number;
}>;

/**
 * The "who" of a revision as the screens see it. A user has no display
 * name of their own (the presentation says 「あなた」); an AI client is
 * told apart by its name. Shared by memo and knowledge, which is why it
 * lives with identity and not with either.
 */
export type ActorView =
  | Readonly<{ kind: "user" }>
  | Readonly<{ kind: "aiClient"; clientName: string }>;

/** Only the client name crosses; the connection id and the user id stay inside. */
export function toActorView(actor: Actor): ActorView {
  return actor.kind === "user"
    ? { kind: "user" }
    : { kind: "aiClient", clientName: actor.clientName };
}
