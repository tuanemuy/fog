export const ExportErrorCode = {
  InvalidTimezone: "INVALID_TIMEZONE",
  OrphanDocument: "ORPHAN_DOCUMENT",
  InvalidArchivePath: "INVALID_ARCHIVE_PATH",
  DuplicateArchivePath: "DUPLICATE_ARCHIVE_PATH",
} as const;

export type ExportErrorCode =
  (typeof ExportErrorCode)[keyof typeof ExportErrorCode];
