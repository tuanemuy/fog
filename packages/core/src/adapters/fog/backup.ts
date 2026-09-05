import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, createClient } from "@libsql/client";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import { z } from "zod";
import { fogSchema } from "./schema";

const artifactPattern =
  /^fog-backup-\d{8}T\d{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stamp = (value: string) => value.replace(/[-:.]/g, "");
const manifestSchema = z
  .object({
    format: z.literal("fog-sqlite-backup"),
    version: z.literal(1),
    id: z.string().regex(artifactPattern),
    createdAt: z.iso.datetime(),
    sensitive: z.literal(true),
    database: z
      .object({
        file: z.literal("snapshot.sqlite"),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    tables: z
      .array(
        z
          .object({ name: z.string(), rows: z.number().int().nonnegative() })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}
const failure = (code: string, message: string) =>
  new BackupError(code, message);
const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;
async function missing(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw failure(
    "DESTINATION_EXISTS",
    "出力先が既に存在します。新しいパスを指定してください。",
  );
}
async function regularFile(file: string, privateOnly = false) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (privateOnly && (info.mode & 0o077) !== 0)
  )
    throw failure(
      "UNSAFE_FILE",
      "通常の所有者専用ファイルを指定してください。",
    );
  return info;
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw failure(
      "UNSAFE_DIRECTORY",
      "バックアップ用ディレクトリはシンボリックリンクを使わず、権限0700にしてください。",
    );
}
async function syncFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function digestFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function removeOwned(file: string) {
  try {
    await unlink(file);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const schemaRow = z.object({
  type: z.string(),
  name: z.string(),
  tableName: z.string(),
  sql: z.string().nullable(),
});
const requiredTables = fogSchema.flatMap((sql) => {
  const name = /^CREATE TABLE IF NOT EXISTS (fog_\w+) /.exec(sql)?.[1];
  return name ? [name] : [];
});
async function inspectDatabase(
  client: Client,
): Promise<Pick<BackupManifest, "schemaSha256" | "tables">> {
  const integrity = await client.execute("PRAGMA integrity_check");
  if (
    integrity.rows.length !== 1 ||
    Object.values(integrity.rows[0] ?? {})[0] !== "ok"
  )
    throw failure(
      "DATABASE_INTEGRITY_FAILED",
      "SQLite整合性検査に失敗しました。",
    );
  if ((await client.execute("PRAGMA foreign_key_check")).rows.length)
    throw failure(
      "DATABASE_FOREIGN_KEYS_FAILED",
      "外部キー整合性検査に失敗しました。",
    );
  const schema = (
    await client.execute(
      "SELECT type,name,tbl_name tableName,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
  ).rows.map((row) => schemaRow.parse(row));
  const names = schema
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();
  if (requiredTables.some((name) => !names.includes(name)))
    throw failure(
      "NOT_FOG_DATABASE",
      "現在のfogデータベースではありません。対応するアプリ版を確認してください。",
    );
  const tables = [];
  for (const name of names) {
    const result = await client.execute(
      `SELECT count(*) AS count FROM ${quote(name)}`,
    );
    tables.push({
      name,
      rows: z.number().int().nonnegative().parse(result.rows[0]?.count),
    });
  }
  return {
    tables,
    schemaSha256: createHash("sha256")
      .update(JSON.stringify(schema))
      .digest("hex"),
  };
}
async function inspectFile(file: string) {
  const client = createClient({ url: pathToFileURL(file).href });
  try {
    await client.execute("PRAGMA query_only=ON");
    await client.execute("PRAGMA trusted_schema=OFF");
    return await inspectDatabase(client);
  } finally {
    client.close();
  }
}
async function cleanupArtifact(directory: string) {
  for (const name of [
    "manifest.pending",
    "manifest.json",
    "snapshot.sqlite",
    "snapshot.sqlite-wal",
    "snapshot.sqlite-shm",
    "snapshot.sqlite-journal",
  ])
    await removeOwned(path.join(directory, name));
  await rmdir(directory);
}

/** VACUUM INTO produces a consistent SQLite snapshot; the source file is never copied. */
export async function createBackup({
  sourcePath,
  backupDirectory,
  clock,
  ids,
}: {
  sourcePath: string;
  backupDirectory: string;
  clock: Clock;
  ids: IdGenerator;
}): Promise<{ directory: string; manifest: BackupManifest }> {
  const source = path.resolve(sourcePath);
  const root = path.resolve(backupDirectory);
  await regularFile(source);
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const header = Buffer.alloc(16);
    await sourceHandle.read(header, 0, 16, 0);
    if (header.toString("binary") !== "SQLite format 3\u0000")
      throw failure(
        "NOT_SQLITE_DATABASE",
        "暗号化されていないSQLiteファイルを指定してください。",
      );
  } finally {
    await sourceHandle.close();
  }
  await privateDirectory(root, true);
  const createdAt = clock.now().toISOString();
  const id = `fog-backup-${stamp(createdAt)}-${ids.next()}`;
  if (!artifactPattern.test(id))
    throw failure(
      "INVALID_BACKUP_ID",
      "バックアップIDの形式が正しくありません。",
    );
  const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  const snapshot = path.join(directory, "snapshot.sqlite");
  try {
    const empty = await open(snapshot, "wx", 0o600);
    await empty.close();
    const client = createClient({ url: pathToFileURL(source).href });
    try {
      await client.execute("PRAGMA busy_timeout=5000");
      await client.execute("PRAGMA synchronous=FULL");
      await client.execute({ sql: "VACUUM INTO ?", args: [snapshot] });
    } finally {
      client.close();
    }
    await syncFile(snapshot);
    const database = await regularFile(snapshot, true);
    const inspected = await inspectFile(snapshot);
    const manifest: BackupManifest = {
      format: "fog-sqlite-backup",
      version: 1,
      id,
      createdAt,
      sensitive: true,
      database: {
        file: "snapshot.sqlite",
        bytes: database.size,
        sha256: await digestFile(snapshot),
      },
      ...inspected,
    };
    const pending = path.join(directory, "manifest.pending");
    const file = await open(pending, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(pending, path.join(directory, "manifest.json"));
    await unlink(pending);
    await syncDirectory(directory);
    await syncDirectory(root);
    return { directory, manifest };
  } catch (error) {
    await cleanupArtifact(directory);
    throw error;
  }
}

export async function verifyBackup(
  backupDirectory: string,
): Promise<BackupManifest> {
  const directory = path.resolve(backupDirectory);
  await privateDirectory(directory);
  if (!artifactPattern.test(path.basename(directory)))
    throw failure(
      "INVALID_BACKUP_ARTIFACT",
      "fogバックアップのディレクトリを指定してください。",
    );
  const entries = (await readdir(directory)).sort();
  if (
    JSON.stringify(entries) !==
    JSON.stringify(["manifest.json", "snapshot.sqlite"])
  )
    throw failure(
      "INVALID_BACKUP_ARTIFACT",
      "バックアップの構成が正しくありません。",
    );
  const manifestPath = path.join(directory, "manifest.json");
  const manifestInfo = await regularFile(manifestPath, true);
  if (manifestInfo.size > 1_000_000)
    throw failure("INVALID_BACKUP_ARTIFACT", "マニフェストが大きすぎます。");
  const file = await open(
    manifestPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let raw: string;
  try {
    raw = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failure("INVALID_BACKUP_ARTIFACT", "マニフェストが破損しています。");
  }
  const validated = manifestSchema.safeParse(parsed);
  if (!validated.success)
    throw failure(
      "INVALID_BACKUP_ARTIFACT",
      "fogバックアップのマニフェストではありません。",
    );
  const manifest = validated.data;
  if (
    manifest.id !== path.basename(directory) ||
    !manifest.id.startsWith(`fog-backup-${stamp(manifest.createdAt)}-`)
  )
    throw failure(
      "INVALID_BACKUP_ARTIFACT",
      "バックアップ名とマニフェストが一致しません。",
    );
  const snapshot = path.join(directory, manifest.database.file);
  const info = await regularFile(snapshot, true);
  if (
    info.size !== manifest.database.bytes ||
    (await digestFile(snapshot)) !== manifest.database.sha256
  )
    throw failure(
      "BACKUP_HASH_MISMATCH",
      "バックアップのサイズまたはSHA-256が一致しません。",
    );
  const inspected = await inspectFile(snapshot);
  if (
    inspected.schemaSha256 !== manifest.schemaSha256 ||
    JSON.stringify(inspected.tables) !== JSON.stringify(manifest.tables)
  )
    throw failure(
      "BACKUP_SCHEMA_MISMATCH",
      "バックアップのスキーマまたは件数が一致しません。",
    );
  return manifest;
}

export async function restoreBackup({
  backupDirectory,
  destinationPath,
  clock,
  ids,
  preserveAccess = false,
}: {
  backupDirectory: string;
  destinationPath: string;
  clock: Clock;
  ids: IdGenerator;
  preserveAccess?: boolean;
}): Promise<{
  destination: string;
  backupId: string;
  access: "preserved" | "revoked";
  sha256: string;
}> {
  const destination = path.resolve(destinationPath);
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    await missing(`${destination}${suffix}`);
  const manifest = await verifyBackup(backupDirectory);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const restoreId = ids.next();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      restoreId,
    )
  )
    throw failure("INVALID_BACKUP_ID", "復元IDの形式が正しくありません。");
  const temporary = path.join(parent, `.fog-restore-${restoreId}.sqlite`);
  for (const suffix of ["-wal", "-shm", "-journal"])
    await missing(`${temporary}${suffix}`);
  const reserved = await open(temporary, "wx", 0o600);
  await reserved.close();
  try {
    await copyFile(
      path.join(path.resolve(backupDirectory), "snapshot.sqlite"),
      temporary,
    );
    const file = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    if ((await digestFile(temporary)) !== manifest.database.sha256)
      throw failure(
        "BACKUP_HASH_MISMATCH",
        "コピー中にバックアップが変更されました。",
      );
    if (!preserveAccess) {
      const client = createClient({ url: pathToFileURL(temporary).href });
      try {
        await client.execute("PRAGMA foreign_keys=ON");
        await client.execute("PRAGMA secure_delete=ON");
        await client.batch(
          [
            "DELETE FROM fog_sessions",
            {
              sql: "UPDATE fog_ai_connections SET revoked_at=coalesce(revoked_at,?)",
              args: [clock.now().toISOString()],
            },
            "DELETE FROM fog_ai_authorization_requests",
            "DELETE FROM fog_ai_authorization_codes",
            "DELETE FROM fog_google_requests",
            "DELETE FROM fog_password_resets",
            "DELETE FROM fog_reset_emails",
          ],
          "write",
        );
        await client.execute("VACUUM");
      } finally {
        client.close();
      }
    }
    const inspected = await inspectFile(temporary);
    if (inspected.schemaSha256 !== manifest.schemaSha256)
      throw failure(
        "BACKUP_SCHEMA_MISMATCH",
        "復元後のスキーマが一致しません。",
      );
    await syncFile(temporary);
    await link(temporary, destination);
    await unlink(temporary);
    await syncDirectory(parent);
    return {
      destination,
      backupId: manifest.id,
      access: preserveAccess ? "preserved" : "revoked",
      sha256: await digestFile(destination),
    };
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await removeOwned(`${temporary}${suffix}`);
  }
}

export async function pruneBackups({
  backupDirectory,
  retentionDays,
  clock,
  apply = false,
}: {
  backupDirectory: string;
  retentionDays: number;
  clock: Clock;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  deleted: string[];
  kept: string[];
  skipped: string[];
}> {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  )
    throw failure(
      "INVALID_RETENTION_DAYS",
      "保持日数は1〜3650で指定してください。",
    );
  const root = path.resolve(backupDirectory);
  await privateDirectory(root);
  const valid: BackupManifest[] = [];
  const skipped: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (!artifactPattern.test(name)) {
      skipped.push(name);
      continue;
    }
    try {
      valid.push(await verifyBackup(path.join(root, name)));
    } catch {
      skipped.push(name);
    }
  }
  valid.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const cutoff = clock.now().getTime() - retentionDays * 86_400_000;
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const [index, manifest] of valid.entries()) {
    if (index === 0 || Date.parse(manifest.createdAt) >= cutoff) {
      kept.push(manifest.id);
      continue;
    }
    if (apply) {
      const directory = path.join(root, manifest.id);
      await verifyBackup(directory);
      await unlink(path.join(directory, "snapshot.sqlite"));
      await unlink(path.join(directory, "manifest.json"));
      await rmdir(directory);
    }
    deleted.push(manifest.id);
  }
  if (apply) await syncDirectory(root);
  return { dryRun: !apply, deleted, kept, skipped };
}
