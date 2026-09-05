import type { AuthResult, HumanActor } from "./types";

export type CredentialView = Readonly<{
  hasPassword: boolean;
  google: Readonly<{
    id: string;
    label: string;
    email: string;
    removable: boolean;
  }>[];
}>;
export type GoogleAuthResult =
  | Readonly<{ kind: "signedIn"; auth: AuthResult; returnTo: string }>
  | Readonly<{ kind: "linked" | "cancelled"; returnTo: string }>;
export interface AccountServices {
  beginGoogleAuth(
    actor: HumanActor | null,
    input: { browserToken: string; returnTo: string },
  ): Promise<{ url: string }>;
  completeGoogleAuth(
    actor: HumanActor | null,
    input: {
      browserToken: string;
      state: string;
      code?: string;
      error?: string;
    },
  ): Promise<GoogleAuthResult>;
  credentials(actor: HumanActor): Promise<CredentialView>;
  unlinkGoogleCredential(
    actor: HumanActor,
    input: { id: string },
  ): Promise<void>;
  changePassword(
    actor: HumanActor,
    input: { currentPassword: string; newPassword: string },
  ): Promise<AuthResult>;
  requestPasswordReset(input: { email: string }): Promise<{ message: string }>;
  completePasswordReset(input: {
    token: string;
    newPassword: string;
  }): Promise<AuthResult>;
  revokeAllAiConnections(actor: HumanActor): Promise<void>;
}
