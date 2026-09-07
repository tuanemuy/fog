import { BusinessRuleError } from "@repo/core/domain/error";
import { type Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { MemoErrorCode } from "./errorCode";
import { MemoBody, MemoId, RevisionNumber } from "./valueObject";

type MemoBase = Readonly<{
  id: MemoId;
  /** The identity of the Durable Object the memo lives in; never a row filter. */
  userId: UserId;
  body: MemoBody;
  latestRevisionNumber: RevisionNumber;
  postedAt: Date;
  version: number;
  updatedAt: Date;
}>;

export type ActiveMemo = MemoBase & Readonly<{ status: "active" }>;
export type TrashedMemo = MemoBase &
  Readonly<{ status: "trashed"; trashedAt: Date; purgeAfter: Date }>;
export type Memo = ActiveMemo | TrashedMemo;

/** Immutable full-text snapshot identified by `(memoId, revisionNumber)`. */
export type MemoRevision = Readonly<{
  memoId: MemoId;
  revisionNumber: RevisionNumber;
  actor: Actor;
  body: MemoBody;
  createdAt: Date;
}>;

function revise(
  memo: ActiveMemo,
  body: MemoBody,
  actor: Actor,
  now: Date,
): { memo: ActiveMemo; newRevision: MemoRevision | null } {
  if (MemoBody.equals(memo.body, body)) return { memo, newRevision: null };
  const revisionNumber = RevisionNumber.next(memo.latestRevisionNumber);
  return {
    memo: {
      ...memo,
      body,
      latestRevisionNumber: revisionNumber,
      version: memo.version + 1,
      updatedAt: now,
    },
    newRevision: {
      memoId: memo.id,
      revisionNumber,
      actor,
      body,
      createdAt: now,
    },
  };
}

export const Memo = {
  /** A memo is born together with its first revision. */
  create: (
    params: { id: string; userId: string; body: string; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; initialRevision: MemoRevision } => {
    const id = MemoId.create(params.id);
    const body = MemoBody.create(params.body);
    const revisionNumber = RevisionNumber.first();
    return {
      memo: {
        id,
        userId: UserId.create(params.userId),
        body,
        latestRevisionNumber: revisionNumber,
        postedAt: now,
        version: 0,
        updatedAt: now,
        status: "active",
      },
      initialRevision: {
        memoId: id,
        revisionNumber,
        actor: params.actor,
        body,
        createdAt: now,
      },
    };
  },

  /** An unchanged body yields no revision and no version bump. */
  edit: (
    memo: ActiveMemo,
    params: { body: string; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; newRevision: MemoRevision | null } =>
    revise(memo, MemoBody.create(params.body), params.actor, now),

  /** A new revision with the past body; history is never rewound. */
  rollback: (
    memo: ActiveMemo,
    params: { targetRevision: MemoRevision; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; newRevision: MemoRevision | null } => {
    if (params.targetRevision.memoId !== memo.id) {
      throw new BusinessRuleError(
        MemoErrorCode.RevisionMismatch,
        "The revision belongs to another memo",
      );
    }
    return revise(memo, params.targetRevision.body, params.actor, now);
  },

  softDelete: (memo: ActiveMemo, purgeAfter: Date, now: Date): TrashedMemo => {
    const { status: _status, ...base } = memo;
    return {
      ...base,
      status: "trashed",
      trashedAt: now,
      purgeAfter,
      version: memo.version + 1,
      updatedAt: now,
    };
  },

  restore: (memo: TrashedMemo, now: Date): ActiveMemo => {
    const {
      status: _status,
      trashedAt: _trashedAt,
      purgeAfter: _purgeAfter,
      ...base
    } = memo;
    return {
      ...base,
      status: "active",
      version: memo.version + 1,
      updatedAt: now,
    };
  },
};
