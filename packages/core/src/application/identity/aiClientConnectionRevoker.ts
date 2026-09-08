/**
 * The two revocation call points a reset needs before the AI-connection
 * repository arrives with the AI slice (PH-06 △-2): the connections
 * created under one `resetVersion`, and all of them. Rows already
 * `revoked` are left alone; each returns the number it revoked.
 */
export interface AiClientConnectionRevoker {
  revokeCreatedAtResetVersion(resetVersion: number): number;
  revokeAll(): number;
}
