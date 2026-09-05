import type { AccountServices } from "./accountTypes";

export type * from "./accountTypes";

import type { AiServices } from "./aiTypes";

export type * from "./aiTypes";

import type { DataServices } from "./dataTypes";

export type * from "./dataTypes";

import type {
  Actor,
  Document,
  Memo,
  RevisionActor,
  Topic,
} from "@repo/core/domain/fog/content";

export type { Actor } from "@repo/core/domain/fog/content";
export type HumanActor = Extract<Actor, { kind: "human" }>;
export type MemoView = Omit<Memo, "ownerId"> &
  Readonly<{
    sourceDocuments: { id: string; title: string; deleted: boolean }[];
  }>;
export type TopicView = Omit<Topic, "ownerId">;
export type DocumentView = Omit<Document, "ownerId"> &
  Readonly<{
    sourceMemos: {
      id: string;
      body: string;
      createdAt: string;
      deleted: boolean;
    }[];
  }>;
export type MemoRevisionView = Readonly<{
  version: number;
  body: string;
  createdAt: string;
  actor: RevisionActor;
}>;
export type DocumentRevisionView = MemoRevisionView &
  Readonly<{ title: string; reason: string }>;
export type TimelineInput = Readonly<{
  limit?: number;
  cursor?: string;
  keyword?: string;
  date?: string;
  memoId?: string;
}>;
export type TimelinePage = Readonly<{
  memos: MemoView[];
  nextCursor: string | null;
  focusId: string | null;
}>;
export type TopicDetail = Readonly<{
  topic: TopicView;
  documents: DocumentView[];
  relatedMemos: MemoView[];
}>;
export type AuthInput = Readonly<{ email: string; password: string }>;
export type AuthResult = Readonly<{ token: string; user: HumanActor }>;
export interface MemoServices {
  listMemos(actor: Actor): Promise<MemoView[]>;
  createMemo(actor: Actor, input: { body: string }): Promise<MemoView>;
  getMemo(actor: Actor, id: string): Promise<MemoView>;
  listTimeline(actor: Actor, input: TimelineInput): Promise<TimelinePage>;
  editMemo(
    actor: Actor,
    input: { id: string; body: string; expectedVersion: number },
  ): Promise<MemoView>;
  memoHistory(actor: HumanActor, id: string): Promise<MemoRevisionView[]>;
  rollbackMemo(
    actor: HumanActor,
    input: { id: string; version: number; expectedVersion: number },
  ): Promise<MemoView>;
}
export interface TopicServices {
  listTopics(actor: Actor): Promise<TopicView[]>;
  getTopic(actor: Actor, id: string): Promise<TopicDetail>;
  createTopic(
    actor: Actor,
    input: { title: string; description: string },
  ): Promise<TopicView>;
  updateTopic(
    actor: Actor,
    input: {
      id: string;
      title: string;
      description: string;
      completed: boolean;
      expectedVersion: number;
    },
  ): Promise<TopicView>;
}
export interface DocumentServices {
  createDocument(
    actor: Actor,
    input: {
      topicId: string;
      title: string;
      body: string;
      sourceMemoIds: string[];
      reason?: string;
    },
  ): Promise<DocumentView>;
  getDocument(actor: Actor, id: string): Promise<DocumentView>;
  editDocument(
    actor: Actor,
    input: {
      id: string;
      title: string;
      body: string;
      reason?: string;
      expectedVersion: number;
    },
  ): Promise<DocumentView>;
  documentHistory(
    actor: HumanActor,
    id: string,
  ): Promise<DocumentRevisionView[]>;
  rollbackDocument(
    actor: HumanActor,
    input: { id: string; version: number; expectedVersion: number },
  ): Promise<DocumentView>;
}
export interface FogServices
  extends MemoServices,
    TopicServices,
    DocumentServices,
    DataServices,
    AiServices,
    AccountServices {
  register(input: AuthInput): Promise<AuthResult>;
  login(input: AuthInput): Promise<AuthResult>;
  authenticate(token: string | undefined): Promise<HumanActor | null>;
  logout(token: string | undefined): Promise<void>;
}
export type RevisionView = MemoRevisionView | DocumentRevisionView;
