/**
 * The snapshot as it crosses the Durable Object boundary: primitives only,
 * instants as epoch milliseconds (design D-15 △-7 — an archive-sized
 * array of `Date` objects is what the structured clone would otherwise
 * carry). The usecase rebuilds `ExportSource` from it on the request side.
 */
export type ExportSourceDto = Readonly<{
  memos: readonly Readonly<{
    memoId: string;
    content: string;
    postedAt: number;
    updatedAt: number;
  }>[];
  topics: readonly Readonly<{
    topicId: string;
    name: string;
    description: string | null;
    archived: boolean;
    createdAt: number;
  }>[];
  documents: readonly Readonly<{
    documentId: string;
    topicId: string;
    title: string;
    content: string;
    /** In `source_links` order; a trashed memo's id stays, a hard-deleted one is gone (ADR-003). */
    sourceMemoIds: readonly string[];
    createdAt: number;
    updatedAt: number;
  }>[];
}>;

export interface ExportGateway {
  /** One RPC, one `transactionSync`, no write; over the cap it is `SystemError(ExportTooLarge)`. */
  readExportSource(userId: string): Promise<ExportSourceDto>;
}
