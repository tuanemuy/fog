/**
 * Outbound DTO for the settings screen. Primitives only.
 *
 * The field list is a security boundary, not a convenience: no verification
 * material, no SSO subject, and **no `email`** — the address original lives on
 * the Identity Directory side and is decrypted one at a time through its own
 * entry (#12), never as part of this projection.
 *
 * `authMethod` is gone with the discriminated union it belonged to. What
 * replaces it is `credentials`, which is also what the UI needs to decide
 * whether to offer a password change (is there an entry with `kind: "email"`
 * and `usableForLogin`?) and which SSO links may be unlinked.
 */
export type CurrentUserView = Readonly<{
  userId: string;
  credentials: readonly {
    credentialId: string;
    kind: "email" | "sso";
    label: string;
    usableForLogin: boolean;
  }[];
  trashRetentionDays: number;
}>;
