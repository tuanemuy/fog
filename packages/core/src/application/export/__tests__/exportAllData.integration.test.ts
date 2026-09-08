import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { readExportSourceDto } from "@repo/core/adapters/cloudflare/stores/exportSourceReader";
import { createZipArchiveWriter } from "@repo/core/adapters/fflate/zipArchiveWriter";
import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { editMemo } from "@repo/core/application/memo/editMemo";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { hardDeleteTrashItem } from "@repo/core/application/trash/hardDeleteTrashItem";
import { dayKeyOf } from "@repo/core/domain/export/exportRenderer";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { document, topic } from "../../knowledge/__tests__/knowledgeFixtures";
import { post, postAt, userActor } from "../../memo/__tests__/memoFixtures";
import { exportAllData } from "../exportAllData";

const decoder = new TextDecoder();

function entriesOf(data: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(data)).map(([path, bytes]) => [
      path,
      decoder.decode(bytes),
    ]),
  );
}

async function asyncRowCounts(userId: string): Promise<[number, number]> {
  return inUserDataStorage(userId, (sql) => [
    sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs").one().n,
    sql.exec<{ n: number }>("SELECT count(*) AS n FROM outbox_events").one().n,
  ]);
}

// R-ST-02 through the real User Data object: one RPC, one transaction, no
// write, and an archive that holds exactly the export scope (ADR-002).
describe("exportAllData through the User Data object", () => {
  it("exports the live memos, topics and documents with their sources and nothing else", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    // Two days apart in Asia/Tokyo; the edited memo keeps only its latest body.
    const early = await postAt(
      container,
      userId,
      "早い日のメモ",
      new Date("2026-07-01T00:12:00Z"),
    );
    const edited = await post(container, userId, "旧バージョン の本文");
    await editMemo({
      container,
      input: {
        userId,
        memoId: edited.id,
        body: "新しい本文",
        expectedVersion: edited.version,
        actor: userActor(userId),
      },
    });
    const trashedMemo = await post(container, userId, "削除済みテキストX");
    const hardDeletedMemo = await post(container, userId, "完全に消えるメモ");

    const live = await topic(container, userId, "トピックA", "進行中");
    const done = await topic(container, userId, "トピックB");
    await updateTopic({
      container,
      input: { userId, topicId: done.id, archived: true },
    });
    const trashedTopic = await topic(container, userId, "ゴミ箱のトピック");

    const sourced = await document(container, userId, live.id, {
      title: "ドキュメントA",
      body: "出典つきの本文",
      sourceMemoIds: [early.id, trashedMemo.id, hardDeletedMemo.id],
    });
    await document(container, userId, live.id, { title: "ドキュメントB" });
    await document(container, userId, done.id, { title: "完了側の文書" });
    const trashedDocument = await document(container, userId, live.id, {
      title: "捨てる文書",
      body: "捨てられた本文",
    });

    await softDeleteMemo({
      container,
      input: { userId, memoId: trashedMemo.id },
    });
    await softDeleteMemo({
      container,
      input: { userId, memoId: hardDeletedMemo.id },
    });
    await hardDeleteTrashItem({
      container,
      input: { userId, kind: "memo", id: hardDeletedMemo.id },
    });
    await trashDocument({
      container,
      input: { userId, documentId: trashedDocument.id },
    });
    await trashTopic({
      container,
      input: { userId, topicId: trashedTopic.id },
    });

    const before = await asyncRowCounts(userId);
    const output = await exportAllData(
      { container, input: { userId, timezone: "Asia/Tokyo" } },
      createZipArchiveWriter(),
    );
    expect(await asyncRowCounts(userId)).toEqual(before);

    expect(output.filename).toMatch(/^fog-export-\d{8}\.zip$/);
    const root = output.filename.replace(/\.zip$/, "");
    const files = entriesOf(output.data);
    const today = dayKeyOf(container.clock.now(), "Asia/Tokyo");
    expect(Object.keys(files).sort()).toEqual(
      [
        `${root}/index.md`,
        `${root}/memos/2026-07-01.md`,
        `${root}/memos/${today}.md`,
        `${root}/topics/トピックA/index.md`,
        `${root}/topics/トピックA/ドキュメントA.md`,
        `${root}/topics/トピックA/ドキュメントB.md`,
        `${root}/topics/トピックB/index.md`,
        `${root}/topics/トピックB/完了側の文書.md`,
      ].sort(),
    );

    const manifest = files[`${root}/index.md`] ?? "";
    expect(manifest).toContain("timezone: Asia/Tokyo");
    expect(manifest).toContain(
      "counts:\n  memos: 2\n  topics: 2\n  documents: 3\n",
    );

    const all = Object.values(files).join("\n");
    expect(all).not.toContain("削除済みテキストX");
    expect(all).not.toContain("旧バージョン");
    expect(all).not.toContain("完全に消えるメモ");
    expect(all).not.toContain("捨てられた本文");
    expect(all).not.toContain("ゴミ箱のトピック");
    expect(all).toContain("新しい本文");

    expect(files[`${root}/memos/2026-07-01.md`]).toBe(
      `---\ntype: memos\ndate: 2026-07-01\n---\n\n## 09:12 (${early.id})\n\n早い日のメモ\n`,
    );
    expect(files[`${root}/topics/トピックB/index.md`]).toContain(
      "archived: true",
    );
    expect(files[`${root}/topics/トピックA/index.md`]).toContain(
      "archived: false\n",
    );
    expect(files[`${root}/topics/トピックA/index.md`]).toContain("\n進行中\n");

    // The sources: a living memo with its day file, a trashed one flagged, the hard-deleted one gone.
    const doc = files[`${root}/topics/トピックA/ドキュメントA.md`] ?? "";
    expect(doc).toContain(
      `  - memoId: ${early.id}\n    postedAt: 2026-07-01T09:12:00+09:00\n    file: ../../memos/2026-07-01.md\n`,
    );
    expect(doc).toContain(`  - memoId: ${trashedMemo.id}\n    deleted: true\n`);
    expect(doc).not.toContain(hardDeletedMemo.id);
    expect(doc.endsWith("---\n\n出典つきの本文\n")).toBe(true);
    expect(doc).toContain(`documentId: ${sourced.id}`);
  });

  it("a user with nothing gets the manifest alone; another user's data never appears", async () => {
    const container = createTestContainer();
    const { userId: other } = await registerTestUser(container);
    await post(container, other, "他人のメモ");
    const { userId } = await registerTestUser(container);

    const output = await exportAllData(
      { container, input: { userId, timezone: "UTC" } },
      createZipArchiveWriter(),
    );
    const files = entriesOf(output.data);
    const root = output.filename.replace(/\.zip$/, "");
    expect(Object.keys(files)).toEqual([`${root}/index.md`]);
    expect(files[`${root}/index.md`]).toContain(
      "counts:\n  memos: 0\n  topics: 0\n  documents: 0\n",
    );
    expect(Object.values(files).join("")).not.toContain("他人のメモ");
  });

  it("the same snapshot exported twice is the same bytes", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await postAt(container, userId, "決定性", new Date("2026-07-01T00:12:00Z"));
    const t = await topic(container, userId, "同名");
    await document(container, userId, t.id, { title: "同題" });
    await document(container, userId, t.id, { title: "同題" });
    const fixedClock = { now: () => new Date("2026-07-20T00:30:00Z") };
    const args = {
      container: { ...container, clock: fixedClock },
      input: { userId, timezone: "Asia/Tokyo" },
    };
    const a = await exportAllData(args, createZipArchiveWriter());
    const b = await exportAllData(args, createZipArchiveWriter());
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Object.keys(entriesOf(a.data)).sort()).toEqual([
      "fog-export-20260720/index.md",
      "fog-export-20260720/memos/2026-07-01.md",
      "fog-export-20260720/topics/同名/index.md",
      "fog-export-20260720/topics/同名/同題-2.md",
      "fog-export-20260720/topics/同名/同題.md",
    ]);
  });

  it("over the byte cap the read is refused before any body leaves storage, and still writes nothing", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await post(container, userId, "x".repeat(600));
    await post(container, userId, "y".repeat(600));

    const before = await asyncRowCounts(userId);
    let caught: unknown = null;
    try {
      await inUserDataStorage(userId, (sql) => readExportSourceDto(sql, 1000));
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(
      SystemErrorCode.ExportTooLarge,
    );
    expect((caught as { retryable: boolean }).retryable).toBe(false);
    expect(await asyncRowCounts(userId)).toEqual(before);

    // Under the cap the same read answers; the cap counts UTF-8 bytes.
    const dto = await inUserDataStorage(userId, (sql) =>
      readExportSourceDto(sql, 1200),
    );
    expect(dto.memos).toHaveLength(2);
    await post(container, userId, "あ".repeat(100));
    let refused = false;
    try {
      await inUserDataStorage(userId, (sql) => readExportSourceDto(sql, 1400));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(
      (await inUserDataStorage(userId, (sql) => readExportSourceDto(sql, 1500)))
        .memos,
    ).toHaveLength(3);
  });
});
