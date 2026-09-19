"use client";

import type { SourceDocumentView } from "@repo/core/application/memo/view";
import { Link } from "@tanstack/react-router";
import { Icon } from "@/components/ui/Icon";

// `.doc-link` in `spec/design/pages/timeline.html`: a pill with the input
// border. The trashed entry is the same pill, dashed and grayed. The dash
// rides `aria-disabled:` because the border shorthand is generated after a
// plain `border-dashed` and would win over it.
const CHIP_BASE =
  "inline-flex items-center gap-xs rounded-full bg-bg-card px-md py-xs font-base text-xs font-medium leading-tight [border:var(--border-input)]";
const LIVE_CHIP_CLASS = `${CHIP_BASE} text-neutral-600 transition-colors hover:border-primary-light hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`;
const TRASHED_CHIP_CLASS = `${CHIP_BASE} cursor-default text-neutral-400 aria-disabled:border-dashed`;

function ChipGlyph({ trashed }: Readonly<{ trashed: boolean }>) {
  return (
    <span
      className={`flex shrink-0 ${trashed ? "text-neutral-300" : "text-primary"}`}
    >
      <Icon name="jump" size="xs" />
    </span>
  );
}

/**
 * The 「→ ドキュメントX」 trail under a memo (S-TL-07, P-04). A document in
 * the trash is shown but not navigable; a hard-deleted one never reaches
 * here (ADR-003). Renders nothing for an empty trail.
 */
export function SourceDocumentLinks({
  documents,
}: {
  documents: readonly SourceDocumentView[];
}) {
  if (documents.length === 0) return null;
  return (
    <nav
      className="mt-sm flex flex-wrap items-center gap-sm"
      aria-label="出典になっているドキュメント"
    >
      {documents.map((document) =>
        document.isTrashed ? (
          <span
            key={document.documentId}
            className={TRASHED_CHIP_CLASS}
            aria-disabled="true"
          >
            <ChipGlyph trashed />
            削除済みのドキュメント
          </span>
        ) : (
          <Link
            key={document.documentId}
            className={LIVE_CHIP_CLASS}
            to="/documents/$documentId"
            params={{ documentId: document.documentId }}
          >
            <ChipGlyph trashed={false} />
            {document.title}
          </Link>
        ),
      )}
    </nav>
  );
}
