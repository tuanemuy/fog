import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { createBackup, restoreBackup, verifyBackup, pruneBackups } from "../../packages/core/src/adapters/fog/backup";
import { migrateFog } from "../../packages/core/src/adapters/fog/schema";
import { UuidV7Generator as ids } from "../../packages/core/src/application/ports/idGenerator";
import { beforeEach, afterEach, test, expect } from "vitest";
let root: string, sourcePath: string, backupDirectory: string, client: Client;
let now: Date;
const clock = { now: () => now };
const backup = () => createBackup({ sourcePath, backupDirectory, clock, ids });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fog-ops-review-"));
  sourcePath = path.join(root, "source.db"); backupDirectory = path.join(root, "backups");
  client = createClient({ url: `file:${sourcePath}` });
  await migrateFog(client);
  now = new Date("2026-01-01T00:00:00.000Z");
});
afterEach(async () => { client.close(); await rm(root, { recursive: true, force: true }); });
test("prune retains corrupt, symlink and unknown artifacts while deleting only expired complete snapshot", async () => {
  const old = await backup();
  now = new Date("2026-02-01T00:00:00.000Z"); const corrupt = await backup();
  await writeFile(path.join(corrupt.directory, "snapshot.sqlite"), "corrupt");
  now = new Date("2026-03-01T00:00:00.000Z"); const newest = await backup();
  const symlinkName = `fog-backup-20260101T000000000Z-${ids.next()}`;
  await symlink(newest.directory, path.join(backupDirectory, symlinkName));
  const unknown = path.join(backupDirectory, "unrelated"); await mkdir(unknown); await writeFile(path.join(unknown, "precious"), "KEEP");
  now = new Date("2026-06-01T00:00:00.000Z");
  const result = await pruneBackups({ backupDirectory, retentionDays: 1, clock, apply: true });
  expect(result.deleted).toEqual([old.manifest.id]); expect(result.kept).toEqual([newest.manifest.id]);
  expect(result.skipped.sort()).toEqual([corrupt.manifest.id, symlinkName, "unrelated"].sort());
  expect(await readFile(path.join(unknown, "precious"), "utf8")).toBe("KEEP");
  expect(await readFile(path.join(corrupt.directory, "snapshot.sqlite"), "utf8")).toBe("corrupt");
  expect(await verifyBackup(newest.directory)).toEqual(newest.manifest);
});
test("snapshot and manifest symlinks reject without touching linked files", async () => {
  for (const file of ["snapshot.sqlite", "manifest.json"]) {
    const artifact = await backup(); const original = path.join(artifact.directory, file);
    const bytes = await readFile(original); const target = path.join(root, file);
    await writeFile(target, bytes, { mode: 0o600 }); await unlink(original); await symlink(target, original);
    await expect(verifyBackup(artifact.directory)).rejects.toMatchObject({ code: "UNSAFE_FILE" });
    expect(await readFile(target)).toEqual(bytes);
  }
});
test("all stale restore work and destination sidecars refuse without unlinking unrelated content", async () => {
  const artifact = await backup(); const destinationPath = path.join(root, "new.db");
  const fixed = { next: () => "00000000-0000-7000-8000-000000000001", validate: () => true };
  for (const prefix of [destinationPath, path.join(root, `.fog-restore-${fixed.next()}.sqlite`)]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const protectedPath = `${prefix}${suffix}`; await writeFile(protectedPath, "KEEP");
      await expect(restoreBackup({ backupDirectory: artifact.directory, destinationPath, clock, ids: fixed })).rejects.toBeDefined();
      expect(await readFile(protectedPath, "utf8")).toBe("KEEP"); await unlink(protectedPath);
    }
  }
  expect(await readdir(root)).not.toContain("new.db");
});
test("migration and full snapshot preserve unknown legacy tables across both restore modes", async () => {
  await client.execute("CREATE TABLE legacy_template(id TEXT PRIMARY KEY, value TEXT)");
  await client.execute("INSERT INTO legacy_template VALUES('legacy', 'retain me')");
  await migrateFog(client);
  const artifact = await backup();
  expect(artifact.manifest.tables).toContainEqual({ name: "legacy_template", rows: 1 });
  for (const preserveAccess of [true, false]) {
    const result = await restoreBackup({ backupDirectory: artifact.directory, destinationPath: path.join(root, `${preserveAccess}.db`), clock, ids, preserveAccess });
    const restored = createClient({ url: `file:${result.destination}` });
    try { expect((await restored.execute("SELECT * FROM legacy_template")).rows).toEqual([{ id: "legacy", value: "retain me" }]); }
    finally { restored.close(); }
  }
});
