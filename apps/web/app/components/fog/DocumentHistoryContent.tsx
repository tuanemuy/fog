"use client";

import type {
  DocumentRevisionView,
  DocumentView,
} from "@repo/core/application/fog/types";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { rollbackFogDocument } from "@/presentation/fogDocumentActions";
import { RevisionHistory } from "./RevisionHistory";

export function DocumentHistoryContent({
  document,
  revisions,
}: {
  document: DocumentView;
  revisions: DocumentRevisionView[];
}) {
  const router = useRouter();
  const rollback = useServerFn(rollbackFogDocument);
  return (
    <RevisionHistory
      kind="document"
      id={document.id}
      revisions={revisions}
      currentVersion={document.version}
      backHref={`/documents/${encodeURIComponent(document.id)}`}
      onRollback={async (version, expectedVersion) => {
        try {
          await rollback({
            data: { id: document.id, version, expectedVersion },
          });
        } finally {
          await router.invalidate();
        }
        await router.navigate({
          to: "/documents/$documentId",
          params: { documentId: document.id },
        });
      }}
    />
  );
}
