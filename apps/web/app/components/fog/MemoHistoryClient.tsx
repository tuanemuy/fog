"use client";
import type { MemoRevisionView } from "@repo/core/application/fog/types";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { rollbackFogMemo } from "@/presentation/fogMemoActions";
import { RevisionHistory } from "./RevisionHistory";

export function MemoHistoryClient({
  id,
  revisions,
  currentVersion,
}: {
  id: string;
  revisions: MemoRevisionView[];
  currentVersion: number;
}) {
  const router = useRouter();
  const rollback = useServerFn(rollbackFogMemo);
  return (
    <RevisionHistory
      kind="memo"
      id={id}
      revisions={revisions}
      currentVersion={currentVersion}
      backHref={`/timeline?memoId=${encodeURIComponent(id)}`}
      onRollback={async (version, expectedVersion) => {
        try {
          await rollback({ data: { id, version, expectedVersion } });
        } finally {
          await router.invalidate();
        }
        await router.navigate({ to: "/timeline", search: { memoId: id } });
      }}
    />
  );
}
