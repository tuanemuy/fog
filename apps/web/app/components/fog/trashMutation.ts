import type { EmptyTrashResult } from "@repo/core/application/fog/types";

export async function runWithInvalidation<T>(
  operation: () => Promise<T>,
  invalidate: () => Promise<unknown>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await invalidate();
  }
}

export const runTrashPurgeMutation = runWithInvalidation<EmptyTrashResult>;

export function partialTrashMessage(result: EmptyTrashResult): string {
  const prefix =
    result.deletedCount > 0
      ? `${result.deletedCount}件を完全に削除しました。`
      : "履歴の削除処理を進めました。";
  return `${prefix}残り${result.remainingCount}件です。もう一度実行してください。`;
}

export function isTrashEmpty(
  visibleItemCount: number,
  purgingCount: number,
): boolean {
  return visibleItemCount === 0 && purgingCount === 0;
}

export function isTrashRestoreDisabled(
  itemPurging: boolean,
  parentPurging: boolean,
): boolean {
  return itemPurging || parentPurging;
}
