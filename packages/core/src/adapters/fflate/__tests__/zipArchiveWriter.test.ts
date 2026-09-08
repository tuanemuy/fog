import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import {
  ExportArchive,
  ExportFile,
} from "@repo/core/domain/export/valueObject";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createZipArchiveWriter } from "../zipArchiveWriter";

const exportedAt = new Date("2026-07-20T00:30:00Z");
const archive = ExportArchive.create({
  rootDirName: "fog-export-20260720",
  files: [
    ExportFile.create("index.md", "---\ntype: manifest\n---\n"),
    ExportFile.create(
      "memos/2026-07-01.md",
      "## 09:12 (01M)\n\n日本語の本文\n",
    ),
    ExportFile.create("topics/読書メモ/index.md", ""),
  ],
  exportedAt,
});

describe("createZipArchiveWriter", () => {
  it("writes every file under the root, UTF-8, and names the zip after it", () => {
    const binary = createZipArchiveWriter().write(archive);
    expect(binary.filename).toBe("fog-export-20260720.zip");
    expect(binary.contentType).toBe("application/zip");
    const entries = unzipSync(binary.data);
    expect(Object.keys(entries).sort()).toEqual([
      "fog-export-20260720/index.md",
      "fog-export-20260720/memos/2026-07-01.md",
      "fog-export-20260720/topics/読書メモ/index.md",
    ]);
    expect(
      new TextDecoder().decode(
        entries["fog-export-20260720/memos/2026-07-01.md"],
      ),
    ).toBe("## 09:12 (01M)\n\n日本語の本文\n");
  });

  it("is deterministic: the same archive gives the same bytes", () => {
    const writer = createZipArchiveWriter();
    const a = writer.write(archive).data;
    const b = writer.write(archive).data;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // The DOS timestamp inside the local header is the export instant, not now.
    const other = writer.write({
      ...archive,
      exportedAt: new Date("2025-01-01T00:00:00Z"),
    }).data;
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
  });

  it("an encoder failure is ArchiveEncodingError", () => {
    const writer = createZipArchiveWriter({
      zip: () => {
        throw new Error("deflate exploded");
      },
    });
    let caught: unknown = null;
    try {
      writer.write(archive);
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(
      SystemErrorCode.ArchiveEncodingError,
    );
    expect((caught as { retryable: boolean }).retryable).toBe(false);
  });
});
