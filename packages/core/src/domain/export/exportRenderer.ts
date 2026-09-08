import { BusinessRuleError } from "@repo/core/domain/error";
import { ExportErrorCode } from "./errorCode";
import {
  type DocumentExportEntry,
  ExportArchive,
  ExportFile,
  type ExportSource,
  type MemoExportEntry,
  resolveSlugs,
  type TopicExportEntry,
  UNTITLED_SLUG,
} from "./valueObject";

type ZonedParts = Readonly<{
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  offset: string;
}>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The wall-clock parts of `date` in `timezone`, and the zone's offset at
 * that instant — derived from the parts themselves (the UTC epoch of the
 * wall clock minus the real epoch), so no `timeZoneName` support is
 * assumed of the runtime's ICU.
 */
function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const year = parts.year ?? "0000";
  const month = parts.month ?? "00";
  const day = parts.day ?? "00";
  const hour = parts.hour ?? "00";
  const minute = parts.minute ?? "00";
  const second = parts.second ?? "00";
  const wallClockUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const wholeSeconds =
    date.getTime() - (((date.getTime() % 1000) + 1000) % 1000);
  const offsetMinutes = Math.round((wallClockUtc - wholeSeconds) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return { year, month, day, hour, minute, second, offset };
}

/** `YYYY-MM-DDTHH:mm:ss±hh:mm` in the request's zone. */
export function formatIsoWithOffset(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

export function dayKeyOf(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function hhmmOf(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  return `${p.hour}:${p.minute}`;
}

/** A YAML double-quoted scalar: every string value in a frontmatter goes through here. */
export function yamlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A body as a file's tail: LF endings, exactly one trailing newline. */
function bodyBlock(text: string): string {
  const normalized = lf(text);
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function byInstantThenId<T>(
  at: (item: T) => Date,
  id: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) =>
    at(a).getTime() - at(b).getTime() ||
    (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}

function renderManifest(
  source: ExportSource,
  exportedAt: Date,
  timezone: string,
): string {
  return [
    "---",
    "type: manifest",
    `exportedAt: ${formatIsoWithOffset(exportedAt, timezone)}`,
    `timezone: ${timezone}`,
    "counts:",
    `  memos: ${source.memos.length}`,
    `  topics: ${source.topics.length}`,
    `  documents: ${source.documents.length}`,
    "---",
    "",
    "# fog エクスポート",
    "",
    "- 対象: すべてのメモ・ドキュメント・トピック（完了済みトピックを含む）。各項目は最新リビジョンのみ",
    "- 含まれないもの: ゴミ箱内の項目、リビジョン履歴",
    "",
  ].join("\n");
}

function renderMemoDay(
  day: string,
  memos: readonly MemoExportEntry[],
  timezone: string,
): string {
  const head = ["---", "type: memos", `date: ${day}`, "---", ""].join("\n");
  const entries = memos.map(
    (memo) =>
      `## ${hhmmOf(memo.postedAt, timezone)} (${memo.memoId})\n\n${bodyBlock(memo.content)}`,
  );
  return `${head}\n${entries.join("\n")}`;
}

function renderTopic(topic: TopicExportEntry, timezone: string): string {
  const head = [
    "---",
    "type: topic",
    `topicId: ${topic.topicId}`,
    `name: ${yamlString(topic.name)}`,
    `archived: ${topic.archived}`,
    `createdAt: ${formatIsoWithOffset(topic.createdAt, timezone)}`,
    "---",
    "",
  ].join("\n");
  return topic.description === null
    ? head
    : `${head}\n${bodyBlock(topic.description)}`;
}

function renderDocument(
  document: DocumentExportEntry,
  topic: TopicExportEntry,
  memosById: ReadonlyMap<string, MemoExportEntry>,
  timezone: string,
): string {
  const lines = [
    "---",
    "type: document",
    `documentId: ${document.documentId}`,
    `title: ${yamlString(document.title)}`,
    `topic: ${yamlString(topic.name)}`,
    `createdAt: ${formatIsoWithOffset(document.createdAt, timezone)}`,
    `updatedAt: ${formatIsoWithOffset(document.updatedAt, timezone)}`,
  ];
  if (document.sourceMemoIds.length === 0) {
    lines.push("sources: []");
  } else {
    lines.push("sources:");
    for (const memoId of document.sourceMemoIds) {
      const memo = memosById.get(memoId);
      lines.push(`  - memoId: ${memoId}`);
      if (memo === undefined) {
        lines.push("    deleted: true");
      } else {
        lines.push(
          `    postedAt: ${formatIsoWithOffset(memo.postedAt, timezone)}`,
          `    file: ../../memos/${dayKeyOf(memo.postedAt, timezone)}.md`,
        );
      }
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${bodyBlock(document.content)}`;
}

/**
 * `spec/domains/export.md` アーカイブ構成, as a pure function of the
 * snapshot, the instant and the zone: the same three always give the same
 * files, byte for byte. The one defensive check on the snapshot is that
 * every document's topic is present.
 */
export function render(
  source: ExportSource,
  exportedAt: Date,
  timezone: string,
): ExportArchive {
  const topicsById = new Map(source.topics.map((t) => [t.topicId, t]));
  for (const document of source.documents) {
    if (!topicsById.has(document.topicId)) {
      throw new BusinessRuleError<ExportErrorCode>(
        ExportErrorCode.OrphanDocument,
        `Document ${document.documentId} belongs to no exported topic`,
      );
    }
  }
  const files: ExportFile[] = [
    ExportFile.create("index.md", renderManifest(source, exportedAt, timezone)),
  ];

  const memos = [...source.memos].sort(
    byInstantThenId(
      (m) => m.postedAt,
      (m) => m.memoId,
    ),
  );
  const days = new Map<string, MemoExportEntry[]>();
  for (const memo of memos) {
    const day = dayKeyOf(memo.postedAt, timezone);
    const bucket = days.get(day);
    if (bucket === undefined) days.set(day, [memo]);
    else bucket.push(memo);
  }
  for (const [day, entries] of days) {
    files.push(
      ExportFile.create(
        `memos/${day}.md`,
        renderMemoDay(day, entries, timezone),
      ),
    );
  }

  const topicSlugs = resolveSlugs(
    source.topics.map((t) => ({
      key: t.topicId,
      name: t.name,
      createdAt: t.createdAt,
    })),
  );
  const memosById = new Map(source.memos.map((m) => [m.memoId, m]));
  for (const topic of source.topics) {
    const topicSlug = topicSlugs.get(topic.topicId) ?? UNTITLED_SLUG;
    files.push(
      ExportFile.create(
        `topics/${topicSlug}/index.md`,
        renderTopic(topic, timezone),
      ),
    );
    const documents = source.documents.filter(
      (d) => d.topicId === topic.topicId,
    );
    const documentSlugs = resolveSlugs(
      documents.map((d) => ({
        key: d.documentId,
        name: d.title,
        createdAt: d.createdAt,
      })),
    );
    for (const document of documents) {
      files.push(
        ExportFile.create(
          `topics/${topicSlug}/${documentSlugs.get(document.documentId) ?? UNTITLED_SLUG}.md`,
          renderDocument(document, topic, memosById, timezone),
        ),
      );
    }
  }

  return ExportArchive.create({
    rootDirName: `fog-export-${dayKeyOf(exportedAt, timezone).replaceAll("-", "")}`,
    files,
    exportedAt,
  });
}

export const ExportRenderer = { render };
