import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { ExportErrorCode } from "../errorCode";
import {
  dayKeyOf,
  formatIsoWithOffset,
  render,
  yamlString,
} from "../exportRenderer";
import type {
  DocumentExportEntry,
  ExportSource,
  MemoExportEntry,
  TopicExportEntry,
} from "../valueObject";

const TZ = "Asia/Tokyo";
const EXPORTED_AT = new Date("2026-07-20T00:30:00Z"); // 09:30 JST

function memo(
  id: string,
  postedAt: string,
  content: string,
  updatedAt = postedAt,
): MemoExportEntry {
  return {
    memoId: id,
    content,
    postedAt: new Date(postedAt),
    updatedAt: new Date(updatedAt),
  };
}

function topic(
  id: string,
  name: string,
  overrides: Partial<TopicExportEntry> = {},
): TopicExportEntry {
  return {
    topicId: id,
    name,
    description: null,
    archived: false,
    createdAt: new Date("2026-06-01T01:00:00Z"),
    ...overrides,
  };
}

function document(
  id: string,
  topicId: string,
  title: string,
  overrides: Partial<DocumentExportEntry> = {},
): DocumentExportEntry {
  return {
    documentId: id,
    topicId,
    title,
    content: "本文",
    sourceMemoIds: [],
    createdAt: new Date("2026-07-01T01:00:00Z"),
    updatedAt: new Date("2026-07-15T09:30:00Z"),
    ...overrides,
  };
}

const EMPTY: ExportSource = { memos: [], topics: [], documents: [] };

function fileOf(source: ExportSource, path: string): string {
  const file = render(source, EXPORTED_AT, TZ).files.find(
    (f) => f.path === path,
  );
  if (file === undefined) throw new Error(`no file ${path}`);
  return file.content;
}

describe("time formatting", () => {
  it("writes the zone's wall clock with its offset", () => {
    expect(formatIsoWithOffset(EXPORTED_AT, TZ)).toBe(
      "2026-07-20T09:30:00+09:00",
    );
    expect(formatIsoWithOffset(EXPORTED_AT, "UTC")).toBe(
      "2026-07-20T00:30:00+00:00",
    );
    expect(formatIsoWithOffset(EXPORTED_AT, "America/New_York")).toBe(
      "2026-07-19T20:30:00-04:00",
    );
    expect(
      formatIsoWithOffset(new Date("2026-01-20T00:30:00Z"), "America/New_York"),
    ).toBe("2026-01-19T19:30:00-05:00");
    expect(
      formatIsoWithOffset(new Date("2026-07-20T00:30:00Z"), "Asia/Kolkata"),
    ).toBe("2026-07-20T06:00:00+05:30");
    expect(dayKeyOf(EXPORTED_AT, TZ)).toBe("2026-07-20");
  });

  it("quotes a YAML string safely", () => {
    expect(yamlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(yamlString("line\nbreak\ttab")).toBe('"line\\nbreak\\ttab\\u0001"');
    expect(yamlString("読書メモ")).toBe('"読書メモ"');
  });
});

describe("render: the archive layout", () => {
  const source: ExportSource = {
    memos: [
      memo("01M1", "2026-07-01T00:12:00Z", "一日目のメモ"),
      memo("01M2", "2026-07-02T12:04:00Z", "二日目のメモ"),
    ],
    topics: [topic("01T1", "読書メモ", { description: "本の記録" })],
    documents: [
      document("01D1", "01T1", "エクスポート設計の論点", {
        sourceMemoIds: ["01M1", "01M2"],
      }),
      document("01D2", "01T1", "二つ目", {
        createdAt: new Date("2026-07-02T01:00:00Z"),
      }),
    ],
  };

  it("has the manifest, one memo file per day, and a directory per topic", () => {
    const archive = render(source, EXPORTED_AT, TZ);
    expect(archive.rootDirName).toBe("fog-export-20260720");
    expect(archive.exportedAt).toBe(EXPORTED_AT);
    expect(archive.files.map((f) => f.path)).toEqual([
      "index.md",
      "memos/2026-07-01.md",
      "memos/2026-07-02.md",
      "topics/読書メモ/index.md",
      "topics/読書メモ/エクスポート設計の論点.md",
      "topics/読書メモ/二つ目.md",
    ]);
  });

  it("the manifest carries the instant, the zone, the counts and the scope", () => {
    expect(fileOf(source, "index.md")).toBe(
      [
        "---",
        "type: manifest",
        "exportedAt: 2026-07-20T09:30:00+09:00",
        "timezone: Asia/Tokyo",
        "counts:",
        "  memos: 2",
        "  topics: 1",
        "  documents: 2",
        "---",
        "",
        "# fog エクスポート",
        "",
        "- 対象: すべてのメモ・ドキュメント・トピック（完了済みトピックを含む）。各項目は最新リビジョンのみ",
        "- 含まれないもの: ゴミ箱内の項目、リビジョン履歴",
        "",
      ].join("\n"),
    );
  });

  it("a topic file is its frontmatter and its description; a null description leaves the frontmatter alone", () => {
    expect(fileOf(source, "topics/読書メモ/index.md")).toBe(
      [
        "---",
        "type: topic",
        "topicId: 01T1",
        'name: "読書メモ"',
        "archived: false",
        "createdAt: 2026-06-01T10:00:00+09:00",
        "---",
        "",
        "本の記録",
        "",
      ].join("\n"),
    );
    const bare: ExportSource = {
      ...EMPTY,
      topics: [topic("01T2", "説明なし", { archived: true })],
    };
    expect(fileOf(bare, "topics/説明なし/index.md")).toBe(
      [
        "---",
        "type: topic",
        "topicId: 01T2",
        'name: "説明なし"',
        "archived: true",
        "createdAt: 2026-06-01T10:00:00+09:00",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("a document's sources point at the day file of each living memo; the body is untouched", () => {
    expect(fileOf(source, "topics/読書メモ/エクスポート設計の論点.md")).toBe(
      [
        "---",
        "type: document",
        "documentId: 01D1",
        'title: "エクスポート設計の論点"',
        'topic: "読書メモ"',
        "createdAt: 2026-07-01T10:00:00+09:00",
        "updatedAt: 2026-07-15T18:30:00+09:00",
        "sources:",
        "  - memoId: 01M1",
        "    postedAt: 2026-07-01T09:12:00+09:00",
        "    file: ../../memos/2026-07-01.md",
        "  - memoId: 01M2",
        "    postedAt: 2026-07-02T21:04:00+09:00",
        "    file: ../../memos/2026-07-02.md",
        "---",
        "",
        "本文",
        "",
      ].join("\n"),
    );
    expect(fileOf(source, "topics/読書メモ/二つ目.md")).toContain(
      "sources: []\n---\n\n本文\n",
    );
  });

  it("a trashed source is `deleted: true` with no file; a hard-deleted one is simply absent", () => {
    const withDeleted: ExportSource = {
      ...source,
      documents: [
        document("01D1", "01T1", "出典つき", {
          sourceMemoIds: ["01M1", "01GONE"],
        }),
      ],
    };
    const content = fileOf(withDeleted, "topics/読書メモ/出典つき.md");
    expect(content).toContain(
      [
        "  - memoId: 01M1",
        "    postedAt: 2026-07-01T09:12:00+09:00",
        "    file: ../../memos/2026-07-01.md",
        "  - memoId: 01GONE",
        "    deleted: true",
        "---",
      ].join("\n"),
    );
    expect(content).not.toContain("01GONE\n    postedAt");
  });
});

describe("render: memo day files", () => {
  it("groups by the zone's day, orders by postedAt, one heading per memo even in the same minute", () => {
    const source: ExportSource = {
      ...EMPTY,
      memos: [
        memo("01LATE", "2026-07-01T12:04:30Z", "夜のメモ"),
        memo("01B", "2026-07-01T00:12:20Z", "同じ分の二つ目"),
        memo("01A", "2026-07-01T00:12:05Z", "朝のメモ"),
      ],
    };
    expect(fileOf(source, "memos/2026-07-01.md")).toBe(
      [
        "---",
        "type: memos",
        "date: 2026-07-01",
        "---",
        "",
        "## 09:12 (01A)",
        "",
        "朝のメモ",
        "",
        "## 09:12 (01B)",
        "",
        "同じ分の二つ目",
        "",
        "## 21:04 (01LATE)",
        "",
        "夜のメモ",
        "",
      ].join("\n"),
    );
  });

  it("splits two memos that share a UTC day but not a JST day", () => {
    const source: ExportSource = {
      ...EMPTY,
      memos: [
        memo("01X", "2026-07-01T14:00:00Z", "x"),
        memo("01Y", "2026-07-01T16:00:00Z", "y"),
      ],
    };
    expect(render(source, EXPORTED_AT, TZ).files.map((f) => f.path)).toEqual([
      "index.md",
      "memos/2026-07-01.md",
      "memos/2026-07-02.md",
    ]);
    expect(render(source, EXPORTED_AT, "UTC").files.map((f) => f.path)).toEqual(
      ["index.md", "memos/2026-07-01.md"],
    );
  });

  it("writes a body as it is — a `##` line included — with LF endings and one trailing newline", () => {
    const source: ExportSource = {
      ...EMPTY,
      memos: [
        memo("01H", "2026-07-01T00:12:00Z", "## 見出しのような行\r\n本文\r\n"),
      ],
    };
    expect(fileOf(source, "memos/2026-07-01.md")).toBe(
      [
        "---",
        "type: memos",
        "date: 2026-07-01",
        "---",
        "",
        "## 09:12 (01H)",
        "",
        "## 見出しのような行",
        "本文",
        "",
      ].join("\n"),
    );
  });
});

describe("render: edge cases", () => {
  it("no data at all is the manifest alone", () => {
    const archive = render(EMPTY, EXPORTED_AT, TZ);
    expect(archive.files.map((f) => f.path)).toEqual(["index.md"]);
    expect(archive.files[0]?.content).toContain(
      "counts:\n  memos: 0\n  topics: 0\n  documents: 0\n",
    );
  });

  it("no memos leaves memos/ out; a topic without documents still has its index.md", () => {
    const source: ExportSource = { ...EMPTY, topics: [topic("01T", "空")] };
    expect(render(source, EXPORTED_AT, TZ).files.map((f) => f.path)).toEqual([
      "index.md",
      "topics/空/index.md",
    ]);
  });

  it("an archived topic is exported with `archived: true`", () => {
    const source: ExportSource = {
      ...EMPTY,
      topics: [topic("01T", "完了", { archived: true })],
      documents: [document("01D", "01T", "残った文書")],
    };
    const paths = render(source, EXPORTED_AT, TZ).files.map((f) => f.path);
    expect(paths).toContain("topics/完了/残った文書.md");
    expect(fileOf(source, "topics/完了/index.md")).toContain("archived: true");
  });

  it("numbers colliding slugs per level only", () => {
    const source: ExportSource = {
      ...EMPTY,
      topics: [
        topic("01T1", "同名", { createdAt: new Date("2026-01-01T00:00:00Z") }),
        topic("01T2", "同名", { createdAt: new Date("2026-01-02T00:00:00Z") }),
      ],
      documents: [
        document("01D1", "01T1", "同じ題", {
          createdAt: new Date("2026-02-01T00:00:00Z"),
        }),
        document("01D2", "01T1", "同じ題", {
          createdAt: new Date("2026-02-02T00:00:00Z"),
        }),
        document("01D3", "01T2", "同じ題"),
      ],
    };
    expect(render(source, EXPORTED_AT, TZ).files.map((f) => f.path)).toEqual([
      "index.md",
      "topics/同名-2/index.md",
      "topics/同名-2/同じ題.md",
      "topics/同名/index.md",
      "topics/同名/同じ題-2.md",
      "topics/同名/同じ題.md",
    ]);
  });

  it("is deterministic: the same snapshot, instant and zone give the same bytes", () => {
    const source: ExportSource = {
      memos: [memo("01M", "2026-07-01T00:12:00Z", "m")],
      topics: [topic("01T", "t")],
      documents: [document("01D", "01T", "d", { sourceMemoIds: ["01M"] })],
    };
    const a = render(source, EXPORTED_AT, TZ);
    const b = render(
      { ...source, memos: [...source.memos] },
      new Date(EXPORTED_AT.getTime()),
      TZ,
    );
    expect(a).toEqual(b);
  });

  it("a document whose topic is missing from the snapshot is refused", () => {
    let caught: unknown = null;
    try {
      render(
        { ...EMPTY, documents: [document("01D", "01NOPE", "迷子")] },
        EXPORTED_AT,
        TZ,
      );
    } catch (error) {
      caught = error;
    }
    expect(isBusinessRuleError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(
      ExportErrorCode.OrphanDocument,
    );
  });
});
