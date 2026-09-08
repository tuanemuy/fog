import { MemoId, RevisionNumber } from "@repo/core/domain/memo/valueObject";
import { NotFoundError, ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { DiffRevisionsDto } from "./gateway";
import { type RevisionDiffView, toRevisionView } from "./view";

export type DiffMemoRevisionsInput = Readonly<{
  userId: string;
  memoId: string;
  baseRevisionNumber: number;
  targetRevisionNumber: number;
}>;

function distinctRevisions(input: DiffRevisionsDto): DiffRevisionsDto {
  if (input.baseRevisionNumber === input.targetRevisionNumber) {
    throw new ValidationError(
      "SAME_REVISION",
      "base and target must be different revisions",
    );
  }
  return input;
}

/**
 * S-TL-05, request side: the two full snapshots. The diff itself is the
 * presentation's to compute — no diff is stored.
 */
export async function diffMemoRevisions({
  container,
  input,
}: ServiceArgs<DiffMemoRevisionsInput>): Promise<RevisionDiffView> {
  return container.memoGateway.diffMemoRevisions(
    input.userId,
    distinctRevisions({
      memoId: MemoId.create(input.memoId),
      baseRevisionNumber: input.baseRevisionNumber,
      targetRevisionNumber: input.targetRevisionNumber,
    }),
  );
}

export function diffMemoRevisionsProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: DiffRevisionsDto,
): RevisionDiffView {
  distinctRevisions(input);
  const memoId = MemoId.create(input.memoId);
  const base = ctx.memoRepository.findRevision(
    memoId,
    RevisionNumber.create(input.baseRevisionNumber),
  );
  const target = ctx.memoRepository.findRevision(
    memoId,
    RevisionNumber.create(input.targetRevisionNumber),
  );
  if (base === null || target === null) {
    throw new NotFoundError(
      "REVISION_NOT_FOUND",
      "One of the revisions was not found",
    );
  }
  return { base: toRevisionView(base), target: toRevisionView(target) };
}
