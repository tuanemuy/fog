import type { ExportSource } from "../valueObject";

/**
 * The one read the export needs: the whole of a user's live data as a
 * snapshot (`spec/domains/export.md`). Synchronous, and run inside the
 * user's own Durable Object in a single `transactionSync` — split reads
 * would let a write land between them and break the archive's
 * cross-references. That the result honours the export scope (no trashed
 * item, the latest revision only, no hard-deleted source id) is the
 * implementation's contract, not re-checked by the renderer.
 *
 * A snapshot larger than the implementation's byte cap is refused with
 * `SystemError(ExportTooLarge)` before its bodies are read.
 */
export interface ExportSourceReader {
  readAll(): ExportSource;
}
