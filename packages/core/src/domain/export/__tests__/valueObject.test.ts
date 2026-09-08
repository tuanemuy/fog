import { isBusinessRuleError } from "@repo/core/domain/error";
import { UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { ExportErrorCode } from "../errorCode";
import {
  ExportArchive,
  ExportFile,
  ExportRequest,
  resolveSlugs,
  resolveTimezone,
  SLUG_MAX_CODE_POINTS,
  slugOf,
  UNTITLED_SLUG,
} from "../valueObject";

const userId = UserId.create("01950000-0000-7000-8000-000000000001");

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("ExportRequest", () => {
  it("accepts an IANA zone and keeps its canonical name", () => {
    expect(ExportRequest.create({ userId, timezone: "Asia/Tokyo" })).toEqual({
      userId,
      timezone: "Asia/Tokyo",
    });
    expect(ExportRequest.create({ userId, timezone: "UTC" }).timezone).toBe(
      "UTC",
    );
    expect(
      ExportRequest.create({ userId, timezone: "asia/tokyo" }).timezone,
    ).toBe("Asia/Tokyo");
    expect(resolveTimezone("Etc/GMT+9")).toBe("Etc/GMT+9");
  });

  it("refuses an empty or unknown zone", () => {
    for (const timezone of ["", "Invalid/Zone", "Asia/Tokyo ", "JST+9"]) {
      expect(codeOf(() => ExportRequest.create({ userId, timezone }))).toBe(
        ExportErrorCode.InvalidTimezone,
      );
    }
  });
});

describe("ExportFile", () => {
  it("accepts a relative .md path and refuses the rest", () => {
    expect(ExportFile.create("index.md", "x").path).toBe("index.md");
    expect(ExportFile.create("topics/読書メモ/a.md", "x").path).toBe(
      "topics/読書メモ/a.md",
    );
    for (const path of [
      "",
      "/index.md",
      "memos/../index.md",
      "memos//a.md",
      "memos/a.txt",
      "memos/",
    ]) {
      expect(codeOf(() => ExportFile.create(path, "x"))).toBe(
        ExportErrorCode.InvalidArchivePath,
      );
    }
  });
});

describe("ExportArchive", () => {
  const exportedAt = new Date("2026-07-20T00:30:00Z");

  it("sorts the files by path and keeps the rest", () => {
    const archive = ExportArchive.create({
      rootDirName: "fog-export-20260720",
      files: [
        ExportFile.create("topics/b/index.md", ""),
        ExportFile.create("index.md", ""),
        ExportFile.create("memos/2026-07-01.md", ""),
      ],
      exportedAt,
    });
    expect(archive.files.map((f) => f.path)).toEqual([
      "index.md",
      "memos/2026-07-01.md",
      "topics/b/index.md",
    ]);
    expect(archive.rootDirName).toBe("fog-export-20260720");
    expect(archive.exportedAt).toBe(exportedAt);
  });

  it("refuses a duplicated path", () => {
    expect(
      codeOf(() =>
        ExportArchive.create({
          rootDirName: "r",
          files: [
            ExportFile.create("index.md", "a"),
            ExportFile.create("index.md", "b"),
          ],
          exportedAt,
        }),
      ),
    ).toBe(ExportErrorCode.DuplicateArchivePath);
  });
});

// spec/domains/export.md スラッグ規則, one row per rule.
describe("slugOf", () => {
  it.each([
    ['A/B:C*?"<>|#', "ABC"],
    ["  読書  メモ  ", "読書-メモ"],
    ["が", "が"],
    ['/*?"', UNTITLED_SLUG],
    ["   ", UNTITLED_SLUG],
    [".hidden-", "hidden"],
    ["--..a..--", "a"],
    ["tab\there", "tab-here"],
    ["ctlx", "ctlx"],
    ["日本語のタイトル", "日本語のタイトル"],
  ])("%j → %s", (input, expected) => {
    expect(slugOf(input)).toBe(expected);
  });

  it("keeps exactly 50 code points and truncates the 51st, surrogate pairs counted once", () => {
    const fifty = "あ".repeat(SLUG_MAX_CODE_POINTS);
    expect(slugOf(fifty)).toBe(fifty);
    expect(slugOf(`${fifty}い`)).toBe(fifty);
    const emoji = "😀".repeat(51);
    expect([...slugOf(emoji)]).toHaveLength(50);
  });
});

describe("resolveSlugs", () => {
  const at = (n: number) => new Date(2026, 0, n);

  it("numbers later same-named items from -2 in createdAt order", () => {
    const slugs = resolveSlugs([
      { key: "c", name: "読書", createdAt: at(3) },
      { key: "a", name: "読書", createdAt: at(1) },
      { key: "b", name: "読書", createdAt: at(2) },
    ]);
    expect([slugs.get("a"), slugs.get("b"), slugs.get("c")]).toEqual([
      "読書",
      "読書-2",
      "読書-3",
    ]);
  });

  it("resolves a collision after truncation and after a suffix the same way", () => {
    const long = "x".repeat(60);
    const truncated = resolveSlugs([
      { key: "a", name: `${long}a`, createdAt: at(1) },
      { key: "b", name: `${long}b`, createdAt: at(2) },
    ]);
    expect(truncated.get("a")).toBe("x".repeat(50));
    expect(truncated.get("b")).toBe(`${"x".repeat(50)}-2`);

    const reserved = resolveSlugs([
      { key: "x", name: "x", createdAt: at(1) },
      { key: "x2", name: "x-2", createdAt: at(2) },
      { key: "x-again", name: "x", createdAt: at(3) },
    ]);
    expect(reserved.get("x-again")).toBe("x-3");
  });

  it("breaks a createdAt tie on the key so the answer is stable", () => {
    const slugs = resolveSlugs([
      { key: "b", name: "同名", createdAt: at(1) },
      { key: "a", name: "同名", createdAt: at(1) },
    ]);
    expect(slugs.get("a")).toBe("同名");
    expect(slugs.get("b")).toBe("同名-2");
  });
});
