import type { AiConnectionView, AiWriteRequest } from "./aiTypes";
import type { ContentRef } from "./dataTypes";

export type AiAuthorizationRequest = Readonly<{
  tokenHash: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  expiresAt: string;
  ownerId: string | null;
  consumed: boolean;
}>;
export type AiAuthorizationCode = Readonly<{
  codeHash: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  ownerId: string;
  expiresAt: string;
}>;
export type AiConnection = AiConnectionView &
  Readonly<{ ownerId: string; tokenHash: string; revokedAt: string | null }>;
export type AiLedgerEntry = Readonly<{
  connectionId: string;
  keyHash: string;
  payloadHash: string;
  operation: AiWriteRequest["operation"];
  requestId: string;
  resource: ContentRef | null;
  createdAt: string;
}>;
export interface AiRepository {
  createRequest(request: AiAuthorizationRequest): Promise<void>;
  findRequest(tokenHash: string): Promise<AiAuthorizationRequest | null>;
  bindRequest(tokenHash: string, ownerId: string): Promise<void>;
  consumeRequest(tokenHash: string): Promise<void>;
  createCode(code: AiAuthorizationCode): Promise<void>;
  findCode(codeHash: string): Promise<AiAuthorizationCode | null>;
  deleteCode(codeHash: string): Promise<void>;
  createConnection(connection: AiConnection): Promise<void>;
  findConnection(tokenHash: string): Promise<AiConnection | null>;
  listConnections(ownerId: string, now: string): Promise<AiConnectionView[]>;
  revokeConnection(ownerId: string, id: string, now: string): Promise<void>;
  touchConnection(id: string, now: string): Promise<void>;
  findLedger(
    connectionId: string,
    keyHash: string,
  ): Promise<AiLedgerEntry | null>;
  saveLedger(entry: AiLedgerEntry): Promise<void>;
}
