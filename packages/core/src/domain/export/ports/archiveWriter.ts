import type { ArchiveBinary, ExportArchive } from "../valueObject";

/**
 * Encodes an archive to a zip. Synchronous and CPU-bound, so it runs on
 * the request side, never inside a Durable Object. A failure to encode is
 * `SystemError(ArchiveEncodingError)`.
 */
export interface ArchiveWriter {
  write(archive: ExportArchive): ArchiveBinary;
}
