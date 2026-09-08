"use client";

import type { SourceDocumentView } from "@repo/core/application/memo/view";
import { Link } from "@tanstack/react-router";

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M5 15L15 5M15 5H7.5M15 5V12.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
    <nav className="fog-doc-links" aria-label="出典になっているドキュメント">
      {documents.map((document) =>
        document.isTrashed ? (
          <span
            key={document.documentId}
            className="fog-doc-link"
            aria-disabled="true"
          >
            <ArrowIcon />
            削除済みのドキュメント
          </span>
        ) : (
          <Link
            key={document.documentId}
            className="fog-doc-link"
            to="/documents/$documentId"
            params={{ documentId: document.documentId }}
          >
            <ArrowIcon />
            {document.title}
          </Link>
        ),
      )}
    </nav>
  );
}
