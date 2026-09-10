import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ArchiveWriter } from "@repo/core/domain/export/ports/archiveWriter";
import type {
  ArchiveBinary,
  ExportArchive,
} from "@repo/core/domain/export/valueObject";
import { type Zippable, zipSync } from "fflate";

export type ZipArchiveWriterOptions = Readonly<{
  /** The encoder; `zipSync` unless a test needs it to fail. */
  zip?: (data: Zippable) => Uint8Array;
}>;

/**
 * `ArchiveWriter` over `fflate.zipSync` (design D-09): every file under
 * `rootDirName/`, UTF-8, deflate level 6, and `mtime` fixed to
 * `exportedAt` so the archive's determinism reaches the zip bytes
 * (D-15 △-5). Pure JS; runs on the request Worker.
 *
 * Limit: fflate converts `mtime` to the DOS timestamp in the process
 * time zone, so the zip bytes are deterministic per zone; workerd runs
 * in UTC, and a Node process elsewhere would encode a different local time.
 */
export function createZipArchiveWriter(
  options: ZipArchiveWriterOptions = {},
): ArchiveWriter {
  const zip = options.zip ?? zipSync;
  const encoder = new TextEncoder();
  return {
    write(archive: ExportArchive): ArchiveBinary {
      const entries: Zippable = {};
      for (const file of archive.files) {
        entries[`${archive.rootDirName}/${file.path}`] = [
          encoder.encode(file.content),
          { level: 6, mtime: archive.exportedAt },
        ];
      }
      let data: Uint8Array;
      try {
        data = zip(entries);
      } catch (cause) {
        throw new SystemError(
          SystemErrorCode.ArchiveEncodingError,
          "The archive could not be encoded",
          cause,
        );
      }
      return {
        filename: `${archive.rootDirName}.zip`,
        contentType: "application/zip",
        data,
      };
    },
  };
}
