import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { Needs, ServiceArgs } from "../types";

export type DeleteMemoByAiInput = Readonly<{ userId: string; memoId: string }>;

/**
 * S-AI-05 `delete` for a memo: the same soft delete as the human's
 * (`softDeleteMemoProcedure`, retention deadline and `purge-trash` wake-up
 * included). The only memo entry the AI presentation may import for a
 * deletion; there is no hard delete to reach.
 */
export async function deleteMemoByAi({
  container,
  input,
}: ServiceArgs<DeleteMemoByAiInput, Needs<"memoGateway">>): Promise<void> {
  await container.memoGateway.softDeleteMemo(
    input.userId,
    MemoId.create(input.memoId),
  );
}
