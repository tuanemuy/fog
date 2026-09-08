import { createZipArchiveWriter } from "@repo/core/adapters/fflate/zipArchiveWriter";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { ExportErrorCode } from "@repo/core/domain/export/errorCode";
import type { ArchiveWriter } from "@repo/core/domain/export/ports/archiveWriter";
import type { ExportArchive } from "@repo/core/domain/export/valueObject";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { trippingExportGateway } from "../../__tests__/fakes";
import {
  isSystemError,
  isValidationError,
  SystemError,
  SystemErrorCode,
} from "../../errors";
import { exportAllData } from "../exportAllData";
import type { ExportSourceDto } from "../gateway";

const NOW = new Date("2026-07-20T00:30:00Z");
const USER = "01950000-0000-7000-8000-000000000001";

const dto: ExportSourceDto = {
  memos: [
    {
      memoId: "01M",
      content: "メモ",
      postedAt: Date.UTC(2026, 6, 1, 0, 12),
      updatedAt: Date.UTC(2026, 6, 1, 0, 12),
    },
  ],
  topics: [
    {
      topicId: "01T",
      name: "読書メモ",
      description: null,
      archived: false,
      createdAt: Date.UTC(2026, 5, 1),
    },
  ],
  documents: [
    {
      documentId: "01D",
      topicId: "01T",
      title: "文書",
      content: "本文",
      sourceMemoIds: ["01M"],
      createdAt: Date.UTC(2026, 6, 1),
      updatedAt: Date.UTC(2026, 6, 2),
    },
  ],
};

function container(readExportSource?: () => Promise<ExportSourceDto>) {
  const calls: string[] = [];
  return {
    calls,
    container: {
      clock: { now: () => NOW },
      exportGateway: trippingExportGateway(
        (name) => {
          throw new Error(`unexpected export gateway call: ${name}`);
        },
        readExportSource === undefined
          ? {}
          : {
              readExportSource: (userId) => {
                calls.push(userId);
                return readExportSource();
              },
            },
      ),
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

describe("exportAllData", () => {
  it("reads once, renders in the zone, zips, and names the file after the day", async () => {
    const { container: c, calls } = container(async () => dto);
    const received: ExportArchive[] = [];
    const writer: ArchiveWriter = {
      write(archive) {
        received.push(archive);
        return createZipArchiveWriter().write(archive);
      },
    };
    const output = await exportAllData(
      { container: c, input: { userId: USER, timezone: "Asia/Tokyo" } },
      writer,
    );
    expect(calls).toEqual([USER]);
    expect(output.filename).toBe("fog-export-20260720.zip");
    expect(output.contentType).toBe("application/zip");
    expect(received[0]?.exportedAt).toBe(NOW);
    expect(received[0]?.files.map((f) => f.path)).toEqual([
      "index.md",
      "memos/2026-07-01.md",
      "topics/読書メモ/index.md",
      "topics/読書メモ/文書.md",
    ]);
    expect(Object.keys(unzipSync(output.data))).toHaveLength(4);
  });

  it("an unknown zone is refused before the object is asked", async () => {
    const { container: c, calls } = container(async () => dto);
    const error = await caught(
      exportAllData(
        { container: c, input: { userId: USER, timezone: "Nowhere/City" } },
        createZipArchiveWriter(),
      ),
    );
    expect(isBusinessRuleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      ExportErrorCode.InvalidTimezone,
    );
    expect(calls).toEqual([]);
  });

  it("a malformed user id is a validation error", async () => {
    const { container: c } = container(async () => dto);
    const error = await caught(
      exportAllData(
        { container: c, input: { userId: "", timezone: "UTC" } },
        createZipArchiveWriter(),
      ),
    );
    expect(isValidationError(error) || isBusinessRuleError(error)).toBe(true);
  });

  it("a gateway failure passes through untouched and nothing is rendered or zipped", async () => {
    const { container: c } = container(async () => {
      throw new SystemError(
        SystemErrorCode.ExportTooLarge,
        "The export exceeds the size limit",
      );
    });
    let written = 0;
    const writer: ArchiveWriter = {
      write() {
        written++;
        throw new Error("must not be reached");
      },
    };
    const error = await caught(
      exportAllData(
        { container: c, input: { userId: USER, timezone: "UTC" } },
        writer,
      ),
    );
    expect(isSystemError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      SystemErrorCode.ExportTooLarge,
    );
    expect(written).toBe(0);
  });
});
