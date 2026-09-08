import { BusinessRuleError } from "@repo/core/domain/error";
import type { UserId } from "@repo/core/domain/identity/valueObject";
import { ExportErrorCode } from "./errorCode";

function fail(code: ExportErrorCode, message: string): never {
  throw new BusinessRuleError<ExportErrorCode>(code, message);
}

/** Whether `Intl` knows the zone; the canonical name when it does. */
export function resolveTimezone(raw: string): string | null {
  if (raw.length === 0) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

export type ExportRequest = Readonly<{
  userId: UserId;
  /** The canonical IANA name (`asia/tokyo` resolves to `Asia/Tokyo`). */
  timezone: string;
}>;

export const ExportRequest = {
  create(input: { userId: UserId; timezone: string }): ExportRequest {
    const timezone = resolveTimezone(input.timezone);
    if (timezone === null) {
      fail(
        ExportErrorCode.InvalidTimezone,
        "timezone must be an IANA time zone name",
      );
    }
    return { userId: input.userId, timezone };
  },
};

export type MemoExportEntry = Readonly<{
  memoId: string;
  content: string;
  postedAt: Date;
  updatedAt: Date;
}>;

export type TopicExportEntry = Readonly<{
  topicId: string;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: Date;
}>;

export type DocumentExportEntry = Readonly<{
  documentId: string;
  topicId: string;
  title: string;
  content: string;
  /** Soft-deleted sources stay (rendered `deleted: true`); hard-deleted ones are absent. */
  sourceMemoIds: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}>;

/** The read-only snapshot the reader hands over; ids are the other domains' ids as strings. */
export type ExportSource = Readonly<{
  memos: readonly MemoExportEntry[];
  topics: readonly TopicExportEntry[];
  documents: readonly DocumentExportEntry[];
}>;

export type ExportFile = Readonly<{
  /** Relative to the archive root, `/`-separated, ending in `.md`. */
  path: string;
  /** UTF-8 Markdown, LF line endings. */
  content: string;
}>;

export const ExportFile = {
  create(path: string, content: string): ExportFile {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      !path.endsWith(".md") ||
      segments.some((s) => s.length === 0 || s === "..")
    ) {
      fail(
        ExportErrorCode.InvalidArchivePath,
        `Archive path is not valid: ${path}`,
      );
    }
    return { path, content };
  },
};

export type ExportArchive = Readonly<{
  /** `fog-export-YYYYMMDD`, the day of `exportedAt` in the request's zone. */
  rootDirName: string;
  /** Sorted by `path`, code-point order. */
  files: readonly ExportFile[];
  exportedAt: Date;
}>;

export const ExportArchive = {
  create(input: {
    rootDirName: string;
    files: readonly ExportFile[];
    exportedAt: Date;
  }): ExportArchive {
    const seen = new Set<string>();
    for (const file of input.files) {
      if (seen.has(file.path)) {
        fail(
          ExportErrorCode.DuplicateArchivePath,
          `Archive path is duplicated: ${file.path}`,
        );
      }
      seen.add(file.path);
    }
    const files = [...input.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return {
      rootDirName: input.rootDirName,
      files,
      exportedAt: input.exportedAt,
    };
  },
};

export type ArchiveBinary = Readonly<{
  /** `{rootDirName}.zip` */
  filename: string;
  contentType: "application/zip";
  data: Uint8Array;
}>;

export const SLUG_MAX_CODE_POINTS = 50;
export const UNTITLED_SLUG = "untitled";

const FORBIDDEN_SLUG_CHARACTERS = new Set([
  "/",
  "\\",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
  "#",
]);

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** `spec/domains/export.md` スラッグ規則 1〜6; collisions are `resolveSlugs`'. */
export function slugOf(name: string): string {
  let slug = name.normalize("NFC").trim().replace(/\s+/g, "-");
  slug = [...slug]
    .filter((ch) => !FORBIDDEN_SLUG_CHARACTERS.has(ch) && !isControl(ch))
    .join("");
  slug = slug.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  if (slug.length === 0) return UNTITLED_SLUG;
  const points = [...slug];
  return points.length > SLUG_MAX_CODE_POINTS
    ? points.slice(0, SLUG_MAX_CODE_POINTS).join("")
    : slug;
}

export type SlugCandidate = Readonly<{
  key: string;
  name: string;
  createdAt: Date;
}>;

/**
 * Rule 7: within one level, the earliest `createdAt` keeps the bare slug
 * and later ones take `-2`, `-3`, …; a suffixed slug that itself collides
 * (with a truncated one, or a name that already ended in `-2`) moves on
 * to the next number. Ties on `createdAt` break on `key` so the answer is
 * deterministic.
 */
export function resolveSlugs(
  candidates: readonly SlugCandidate[],
): Map<string, string> {
  const ordered = [...candidates].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const candidate of ordered) {
    const base = slugOf(candidate.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    result.set(candidate.key, slug);
  }
  return result;
}
