import type { SearchKey } from "@repo/core/domain/fog/data";
import type { AccountRepository } from "./accountPorts";
import type { AiRepository } from "./aiPorts";

export type { SearchKey } from "@repo/core/domain/fog/data";

import type {
  Actor,
  Document,
  DocumentRevision,
  Memo,
  MemoRevision,
  Topic,
} from "@repo/core/domain/fog/content";
import type { ContentRef, SearchResult, TrashRecord } from "./dataTypes";

export type User = Readonly<{ id: string; email: string; createdAt: string }>;
export type PasswordCredential = Readonly<{
  userId: string;
  passwordHash: string;
}>;
export type Session = Readonly<{
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}>;
export type AuthAttempt = Readonly<{
  key: string;
  count: number;
  expiresAt: string;
}>;

export interface AuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  findUser(id: string): Promise<User | null>;
  createUser(user: User, passwordHash?: string): Promise<void>;
  passwordCredential(userId: string): Promise<PasswordCredential | null>;
  saveSession(session: Session): Promise<void>;
  findSession(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  getAttempt(key: string): Promise<AuthAttempt | null>;
  saveAttempt(attempt: AuthAttempt): Promise<void>;
  deleteAttempt(key: string): Promise<void>;
}

export interface MemoRepository {
  list(): Promise<Memo[]>;
  find(id: string): Promise<Memo | null>;
  create(memo: Memo, actor: Actor): Promise<void>;
  page(input: {
    limit: number;
    keyword: string;
    before?: { createdAt: string; id: string };
    at?: { createdAt: string; id: string };
  }): Promise<Memo[]>;
  nearest(date: string, keyword: string): Promise<Memo | null>;
  update(memo: Memo, expectedVersion: number, actor: Actor): Promise<void>;
  history(id: string): Promise<MemoRevision[]>;
  sourceDocuments(
    id: string,
  ): Promise<{ id: string; title: string; deleted: boolean }[]>;
}

export interface TopicRepository {
  list(): Promise<Topic[]>;
  find(id: string): Promise<Topic | null>;
  create(topic: Topic): Promise<void>;
  update(topic: Topic, expectedVersion: number): Promise<void>;
}
export interface DocumentRepository {
  list(topicId: string): Promise<Document[]>;
  find(id: string): Promise<Document | null>;
  create(
    document: Document,
    sourceMemoIds: string[],
    actor: Actor,
    reason: string,
  ): Promise<void>;
  update(
    document: Document,
    expectedVersion: number,
    actor: Actor,
    reason: string,
  ): Promise<void>;
  history(id: string): Promise<DocumentRevision[]>;
  sourceMemos(
    id: string,
  ): Promise<
    { id: string; body: string; createdAt: string; deleted: boolean }[]
  >;
  relatedMemos(topicId: string): Promise<Memo[]>;
}
export interface FogUnitOfWork {
  auth: AuthRepository;
  account: AccountRepository;
  ai: AiRepository;
  data(ownerId: string): DataRepository;
  retentionOwners(): Promise<{ id: string; retentionDays: number }[]>;
  memos(ownerId: string): MemoRepository;
  topics(ownerId: string): TopicRepository;
  documents(ownerId: string): DocumentRepository;
}

/** Reads, dependent validation, and writes share one database transaction. */
export interface FogUnitOfWorkProvider {
  run<T>(operation: (context: FogUnitOfWork) => Promise<T>): Promise<T>;
}

export interface SecretCrypto {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  newToken(): string;
  digestToken(token: string): string;
  pkceChallenge(verifier: string): string;
}

export type SearchRow = Omit<SearchResult, "snippet" | "sourceIds"> &
  Readonly<{ body: string }>;
export interface DataRepository {
  trash(): Promise<TrashRecord[]>;
  findTrash(ref: ContentRef): Promise<TrashRecord | null>;
  softDelete(
    ref: ContentRef,
    expectedVersion: number,
    deletedAt: string,
    group: string,
  ): Promise<void>;
  restore(ref: ContentRef, topicId?: string): Promise<void>;
  hardDelete(ref: ContentRef): Promise<number>;
  retentionDays(): Promise<number>;
  setRetentionDays(days: number): Promise<void>;
  search(input: {
    query: string;
    topicId?: string;
    limit: number;
    before?: SearchKey;
  }): Promise<SearchRow[]>;
  sourceIds(ref: ContentRef): Promise<string[]>;
}
