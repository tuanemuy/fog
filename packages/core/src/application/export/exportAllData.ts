import { render } from "@repo/core/domain/export/exportRenderer";
import type { ArchiveWriter } from "@repo/core/domain/export/ports/archiveWriter";
import {
  ExportRequest,
  type ExportSource,
} from "@repo/core/domain/export/valueObject";
import { UserId } from "@repo/core/domain/identity/valueObject";
import type { Needs, ServiceArgs } from "../types";
import type { ExportSourceDto } from "./gateway";

export type ExportAllDataInput = Readonly<{
  userId: string;
  /** IANA zone name the browser resolved; drives the day files and every timestamp. */
  timezone: string;
}>;

export type ExportAllDataOutput = Readonly<{
  filename: string;
  contentType: "application/zip";
  data: Uint8Array;
}>;

export function toExportSource(dto: ExportSourceDto): ExportSource {
  return {
    memos: dto.memos.map((m) => ({
      memoId: m.memoId,
      content: m.content,
      postedAt: new Date(m.postedAt),
      updatedAt: new Date(m.updatedAt),
    })),
    topics: dto.topics.map((t) => ({
      topicId: t.topicId,
      name: t.name,
      description: t.description,
      archived: t.archived,
      createdAt: new Date(t.createdAt),
    })),
    documents: dto.documents.map((d) => ({
      documentId: d.documentId,
      topicId: d.topicId,
      title: d.title,
      content: d.content,
      sourceMemoIds: d.sourceMemoIds,
      createdAt: new Date(d.createdAt),
      updatedAt: new Date(d.updatedAt),
    })),
  };
}

/**
 * S-ST-02, human UI only: the snapshot is read by the user's own object in
 * one transaction, rendered and zipped here on the request side. Nothing
 * is written anywhere, so it runs on an object that has no room left to
 * write. `archiveWriter` is handed in by the presentation layer rather
 * than carried on the container: zipping is request-side CPU work and no
 * other usecase needs it.
 */
export async function exportAllData(
  {
    container,
    input,
  }: ServiceArgs<ExportAllDataInput, Needs<"exportGateway" | "clock">>,
  archiveWriter: ArchiveWriter,
): Promise<ExportAllDataOutput> {
  const exportedAt = container.clock.now();
  const request = ExportRequest.create({
    userId: UserId.create(input.userId),
    timezone: input.timezone,
  });
  const dto = await container.exportGateway.readExportSource(request.userId);
  const archive = render(toExportSource(dto), exportedAt, request.timezone);
  const binary = archiveWriter.write(archive);
  return {
    filename: binary.filename,
    contentType: "application/zip",
    data: binary.data,
  };
}
