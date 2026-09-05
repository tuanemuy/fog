import type { ContentRef, SearchInput, SearchPage } from "./dataTypes";
import type {
  DocumentServices,
  DocumentView,
  HumanActor,
  MemoServices,
  MemoView,
  TimelinePage,
  TopicDetail,
  TopicServices,
  TopicView,
} from "./types";

export type AiClient = Readonly<{
  id: string;
  name: string;
  redirectUris: readonly string[];
}>;
export type BeginAiAuthorization = Readonly<{
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}>;
export type AiAuthorizationView = Readonly<{
  clientId: string;
  clientName: string;
  redirectUri: string;
  expiresAt: string;
  operations: readonly string[];
  guidance: readonly string[];
}>;
export type AiConnectionView = Readonly<{
  id: string;
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}>;
export type AiReadRequest =
  | { operation: "guidance"; input: Record<string, never> }
  | { operation: "memos.recent"; input: { limit?: number; cursor?: string } }
  | { operation: "memos.get"; input: { id: string } }
  | { operation: "topics.list"; input: Record<string, never> }
  | { operation: "topics.get"; input: { id: string } }
  | { operation: "documents.get"; input: { id: string } }
  | { operation: "search"; input: SearchInput };
export type AiWriteRequest = (
  | {
      operation: "memos.create";
      input: Parameters<MemoServices["createMemo"]>[1];
    }
  | {
      operation: "memos.replace";
      input: Parameters<MemoServices["editMemo"]>[1];
    }
  | {
      operation: "topics.create";
      input: Parameters<TopicServices["createTopic"]>[1];
    }
  | {
      operation: "topics.update";
      input: Parameters<TopicServices["updateTopic"]>[1];
    }
  | {
      operation: "documents.create";
      input: Parameters<DocumentServices["createDocument"]>[1] & {
        reason: string;
      };
    }
  | {
      operation: "documents.patch";
      input: {
        id: string;
        expectedVersion: number;
        find: string;
        replace: string;
        reason: string;
        title?: string;
      };
    }
  | {
      operation: "documents.rewrite";
      input: {
        id: string;
        expectedVersion: number;
        title: string;
        body: string;
        reason: string;
        confirmRewrite: true;
      };
    }
  | {
      operation: "content.delete";
      input: ContentRef & { expectedVersion: number };
    }
) & { idempotencyKey: string };
export type AiRequest = AiReadRequest | AiWriteRequest;
export type AiResource = ContentRef & Readonly<{ version: number }>;
export type AiMemoView = Omit<MemoView, "sourceDocuments"> & {
  sourceDocuments: { id: string; title: string }[];
};
export type AiDocumentView = Omit<DocumentView, "sourceMemos"> & {
  sourceMemos: { id: string; body: string; createdAt: string }[];
};
export type AiTopicDetail = Omit<TopicDetail, "documents" | "relatedMemos"> & {
  documents: AiDocumentView[];
  relatedMemos: AiMemoView[];
};
export type AiTimelinePage = Omit<TimelinePage, "memos"> & {
  memos: AiMemoView[];
};
export type AiReadResult =
  | {
      kind: "read";
      operation: "guidance";
      data: { operations: readonly string[]; guidance: readonly string[] };
    }
  | { kind: "read"; operation: "memos.recent"; data: AiTimelinePage }
  | { kind: "read"; operation: "memos.get"; data: AiMemoView }
  | { kind: "read"; operation: "topics.list"; data: TopicView[] }
  | { kind: "read"; operation: "topics.get"; data: AiTopicDetail }
  | { kind: "read"; operation: "documents.get"; data: AiDocumentView }
  | { kind: "read"; operation: "search"; data: SearchPage };
export type AiReceipt = Readonly<{
  kind: "receipt";
  operation: AiWriteRequest["operation"];
  requestId: string;
  replayed: boolean;
  resource: AiResource | null;
}>;
export type AiResult = AiReadResult | AiReceipt;
export interface AiServices {
  beginAiAuthorization(
    input: BeginAiAuthorization,
  ): Promise<{ requestToken: string; expiresAt: string }>;
  getAiAuthorization(
    actor: HumanActor,
    requestToken: string,
  ): Promise<AiAuthorizationView>;
  decideAiAuthorization(
    actor: HumanActor,
    input: { requestToken: string; allow: boolean },
  ): Promise<{ redirectUri: string }>;
  exchangeAiCode(input: {
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }>;
  listAiConnections(actor: HumanActor): Promise<AiConnectionView[]>;
  revokeAiConnection(actor: HumanActor, input: { id: string }): Promise<void>;
  executeAi(accessToken: string, request: AiRequest): Promise<AiResult>;
}
