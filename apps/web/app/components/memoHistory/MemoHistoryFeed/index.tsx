import { Link } from "@tanstack/react-router";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { RevisionHistory } from "../RevisionHistory";

const loadRevisions = serverData(
  () => import("@repo/core/application/memo/listMemoRevisions"),
  async (
    { container },
    { listMemoRevisions },
    userId: string,
    memoId: string,
  ) => listMemoRevisions({ container, input: { userId, memoId } }),
);

/** P-05's "not found" state: a wrong or deleted id, with the way back. */
export function MemoHistoryNotFound() {
  return (
    <div className="fog-history fog-empty" role="status">
      <h2>メモが見つかりません</h2>
      <p>削除されたか、URL のメモ ID が正しくありません。</p>
      <p>
        <Link to="/" className="fog-secondary fog-link-button">
          タイムラインへ
        </Link>
      </p>
    </div>
  );
}

/**
 * The streamed leaf of `/memos/:id/history`. Absence is a screen state,
 * not an error page, so `NotFoundError` is caught after the guard has
 * classified it; everything else keeps propagating.
 */
export async function MemoHistoryFeed({ memoId }: { memoId: string }) {
  let view: Awaited<ReturnType<typeof loadRevisions>>;
  try {
    view = await guardStreamedRender(async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      return loadRevisions(userId, memoId);
    });
  } catch (error) {
    if (extractSerializedError(error).kind === "notFound") {
      return <MemoHistoryNotFound />;
    }
    throw error;
  }
  return (
    <RevisionHistory
      key={memoId}
      memoId={view.memoId}
      revisions={view.revisions}
    />
  );
}
