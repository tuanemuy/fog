import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "@repo/core/application/fog/services";
import type { AuthResult, FogServices } from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from "../backup";
import { nodeSecretCrypto } from "../crypto";
import { migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

let directory: string;
let sourcePath: string;
let backupDirectory: string;
let client: Client;
let services: FogServices;
let now: Date;
let auth: AuthResult;
const clock = { now: () => now };
const ids = UuidV7Generator;
const aiClients = [
  {
    id: "fixture",
    name: "Fixture AI",
    redirectUris: ["http://127.0.0.1/callback"],
  },
];
const makeServices = (database = client) =>
  createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(database),
    crypto: nodeSecretCrypto,
    clock,
    ids,
    aiClients,
    appUrl: "http://localhost:3000",
    googleIdentity: {
      authorizationUrl: (input) =>
        `https://google.example/?${new URLSearchParams(input)}`,
      exchange: async () => ({
        subject: "subject",
        email: "google@example.com",
        emailVerified: true as const,
      }),
    },
  });
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "fog-backup-"));
  sourcePath = path.join(directory, "source with space.db");
  backupDirectory = path.join(directory, "backups");
  client = createClient({ url: `file:${sourcePath}` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA foreign_keys=ON");
  await migrateFog(client);
  now = new Date("2026-09-05T14:00:00.000Z");
  services = await makeServices();
  auth = await services.register({
    email: "backup@example.com",
    password: "long-enough-password",
  });
});
afterEach(async () => {
  client.close();
  await rm(directory, { recursive: true, force: true });
});
const backup = () => createBackup({ sourcePath, backupDirectory, clock, ids });
const restore = (
  artifact: string,
  destination = path.join(directory, "restored.db"),
  preserveAccess = false,
) =>
  restoreBackup({
    backupDirectory: artifact,
    destinationPath: destination,
    clock,
    ids,
    preserveAccess,
  });
async function rows(database: Client): Promise<Record<string, string[]>> {
  const tables = (
    await database.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows;
  const result: Record<string, string[]> = {};
  for (const { name } of tables) {
    if (typeof name !== "string") throw new Error("table");
    result[name] = (
      await database.execute(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
    ).rows
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return result;
}
async function approveAi(exchange = true) {
  const verifier = "v".repeat(43);
  const request = await services.beginAiAuthorization({
    clientId: "fixture",
    redirectUri: "http://127.0.0.1/callback",
    state: "state",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256",
  });
  await services.getAiAuthorization(auth.user, request.requestToken);
  const consent = await services.decideAiAuthorization(auth.user, {
    requestToken: request.requestToken,
    allow: true,
  });
  const code = new URL(consent.redirectUri).searchParams.get("code");
  if (!code) throw new Error("code");
  if (!exchange) return code;
  return (
    await services.exchangeAiCode({
      clientId: "fixture",
      redirectUri: "http://127.0.0.1/callback",
      code,
      codeVerifier: verifier,
    })
  ).accessToken;
}
async function populate() {
  await expect(
    services.login({ email: auth.user.email, password: "wrong" }),
  ).rejects.toBeDefined();
  const memo = await services.createMemo(auth.user, {
    body: "バックアップ元メモ",
  });
  await services.editMemo(auth.user, {
    id: memo.id,
    body: "最新の原文",
    expectedVersion: 1,
  });
  const topic = await services.createTopic(auth.user, {
    title: "保管",
    description: "説明",
  });
  const document = await services.createDocument(auth.user, {
    topicId: topic.id,
    title: "文書",
    body: "履歴前",
    sourceMemoIds: [memo.id],
  });
  await services.editDocument(auth.user, {
    id: document.id,
    title: "改訂文書",
    body: "最新本文",
    expectedVersion: 1,
  });
  await services.softDelete(auth.user, {
    kind: "document",
    id: document.id,
    expectedVersion: 2,
  });
  await services.updateTopic(auth.user, {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    completed: true,
    expectedVersion: 1,
  });
  await services.setRetentionDays(auth.user, { retentionDays: 45 });
  const token = await approveAi();
  const request = {
    operation: "memos.create" as const,
    input: { body: "AIの永続要求" },
    idempotencyKey: "durable",
  };
  const receipt = await services.executeAi(token, request);
  await approveAi(false);
  const google = await services.beginGoogleAuth(null, {
    browserToken: "browser".repeat(8),
    returnTo: "/timeline",
  });
  const state = new URL(google.url).searchParams.get("state");
  if (!state) throw new Error("state");
  await services.completeGoogleAuth(null, {
    browserToken: "browser".repeat(8),
    state,
    code: "fixture",
  });
  await services.beginGoogleAuth(auth.user, {
    browserToken: "browser".repeat(8),
    returnTo: "/settings",
  });
  await new LibsqlFogUnitOfWork(client).run(({ account }) =>
    account.saveLastResetAt(auth.user.userId, now.toISOString()),
  );
  await services.requestPasswordReset({ email: auth.user.email });
  return { token, request, receipt, memo, document, topic };
}

test("consistent snapshot preserves every persistent table including credentials, ledger, history, source links, trash and reset outbox", async () => {
  const fixture = await populate();
  const before = await rows(client);
  expect(Object.values(before).every((values) => values.length > 0)).toBe(true);
  const artifact = await backup();
  expect(artifact.manifest.tables.map((table) => table.name)).toEqual(
    Object.keys(before),
  );
  expect((await lstat(artifact.directory)).mode & 0o777).toBe(0o700);
  for (const name of ["manifest.json", "snapshot.sqlite"])
    expect(
      (await lstat(path.join(artifact.directory, name))).mode & 0o777,
    ).toBe(0o600);
  expect(await verifyBackup(artifact.directory)).toEqual(artifact.manifest);
  const result = await restore(artifact.directory, undefined, true);
  expect(result.access).toBe("preserved");
  expect(result.sha256).toBe(artifact.manifest.database.sha256);
  const restored = createClient({ url: `file:${result.destination}` });
  try {
    expect(await rows(restored)).toEqual(before);
    const restoredServices = await makeServices(restored);
    expect(await restoredServices.authenticate(auth.token)).toEqual(auth.user);
    const replay = await restoredServices.executeAi(
      fixture.token,
      fixture.request,
    );
    expect(replay).toMatchObject({ ...fixture.receipt, replayed: true });
    await expect(
      restoredServices.documentHistory(auth.user, fixture.document.id),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    await restoredServices.restore(auth.user, {
      kind: "document",
      id: fixture.document.id,
    });
    expect(
      await restoredServices.documentHistory(auth.user, fixture.document.id),
    ).toHaveLength(2);
    expect(
      (await restoredServices.getDocument(auth.user, fixture.document.id))
        .sourceMemos[0]?.id,
    ).toBe(fixture.memo.id);
  } finally {
    restored.close();
  }
  expect(await rows(client)).toEqual(before);
});

test("default restore revokes all-owner sessions, AI grants and pending flows while preserving durable content and idempotency ledger", async () => {
  const fixture = await populate();
  const before = await rows(client);
  const artifact = await backup();
  const result = await restore(artifact.directory);
  expect(result.access).toBe("revoked");
  expect((await lstat(result.destination)).mode & 0o777).toBe(0o600);
  const restored = createClient({ url: `file:${result.destination}` });
  try {
    const after = await rows(restored);
    for (const name of [
      "fog_memos",
      "fog_memo_revisions",
      "fog_topics",
      "fog_documents",
      "fog_document_revisions",
      "fog_document_sources",
      "fog_google_credentials",
      "fog_password_credentials",
      "fog_ai_idempotency",
      "fog_account_recovery",
      "fog_users",
    ])
      expect(after[name]).toEqual(before[name]);
    for (const name of [
      "fog_sessions",
      "fog_ai_authorization_requests",
      "fog_ai_authorization_codes",
      "fog_google_requests",
      "fog_password_resets",
      "fog_reset_emails",
    ])
      expect(after[name]).toEqual([]);
    expect(
      (
        await restored.execute("SELECT revoked_at FROM fog_ai_connections")
      ).rows.every((row) => row.revoked_at === now.toISOString()),
    ).toBe(true);
    const restoredServices = await makeServices(restored);
    expect(await restoredServices.authenticate(auth.token)).toBeNull();
    await expect(
      restoredServices.executeAi(fixture.token, fixture.request),
    ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
    expect(
      (
        await restoredServices.login({
          email: auth.user.email,
          password: "long-enough-password",
        })
      ).user,
    ).toEqual(auth.user);
    expect((await restored.execute("PRAGMA foreign_key_check")).rows).toEqual(
      [],
    );
  } finally {
    restored.close();
  }
  expect(await verifyBackup(artifact.directory)).toEqual(artifact.manifest);
  expect(await rows(client)).toEqual(before);
});

test("WAL snapshot excludes an uncommitted multi-table update and a subsequent snapshot includes the committed revision", async () => {
  const memo = await services.createMemo(auth.user, { body: "確定済み" });
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: "UPDATE fog_memos SET body=?,version=2 WHERE id=?",
      args: ["まだ未確定", memo.id],
    });
    await tx.execute({
      sql: "INSERT INTO fog_memo_revisions(memo_id,owner_id,version,body,actor_kind,actor_id,actor_name,created_at) VALUES(?,?,2,?,'human',?,?,?)",
      args: [
        memo.id,
        auth.user.userId,
        "まだ未確定",
        auth.user.userId,
        auth.user.email,
        now.toISOString(),
      ],
    });
    const artifact = await backup();
    const result = await restore(artifact.directory, undefined, true);
    const restored = createClient({ url: `file:${result.destination}` });
    try {
      const restoredServices = await makeServices(restored);
      expect((await restoredServices.getMemo(auth.user, memo.id)).body).toBe(
        "確定済み",
      );
      expect(
        await restoredServices.memoHistory(auth.user, memo.id),
      ).toHaveLength(1);
    } finally {
      restored.close();
    }
    await tx.commit();
  } finally {
    if (!tx.closed) await tx.rollback();
    tx.close();
  }
  const artifact = await backup();
  const result = await restore(
    artifact.directory,
    path.join(directory, "committed.db"),
    true,
  );
  const restored = createClient({ url: `file:${result.destination}` });
  try {
    const restoredServices = await makeServices(restored);
    expect((await restoredServices.getMemo(auth.user, memo.id)).body).toBe(
      "まだ未確定",
    );
    expect(await restoredServices.memoHistory(auth.user, memo.id)).toHaveLength(
      2,
    );
  } finally {
    restored.close();
  }
});

test("restoration refuses existing destination, source database and stale sidecars without changing either database", async () => {
  const artifact = await backup();
  const destination = path.join(directory, "existing.db");
  await writeFile(destination, "keep me");
  await expect(restore(artifact.directory, destination)).rejects.toMatchObject({
    code: "DESTINATION_EXISTS",
  });
  expect(await readFile(destination, "utf8")).toBe("keep me");
  await expect(restore(artifact.directory, sourcePath)).rejects.toMatchObject({
    code: "DESTINATION_EXISTS",
  });
  expect(await services.authenticate(auth.token)).toEqual(auth.user);
  const stale = path.join(directory, "stale.db");
  await writeFile(`${stale}-wal`, "stale");
  await expect(restore(artifact.directory, stale)).rejects.toMatchObject({
    code: "DESTINATION_EXISTS",
  });
  expect(await readFile(`${stale}-wal`, "utf8")).toBe("stale");
  const restored = await restore(artifact.directory);
  await expect(restore(artifact.directory)).rejects.toMatchObject({
    code: "DESTINATION_EXISTS",
  });
  expect(await readFile(restored.destination)).not.toHaveLength(0);
});

test("corrupt snapshot and wrong application manifests are rejected before producing a destination", async () => {
  const artifact = await backup();
  const snapshot = path.join(artifact.directory, "snapshot.sqlite");
  await writeFile(snapshot, Buffer.from("corrupt"));
  await expect(restore(artifact.directory)).rejects.toMatchObject({
    code: "BACKUP_HASH_MISMATCH",
  });
  expect(await readdir(directory)).not.toContain("restored.db");
  const another = await backup();
  const manifest = path.join(another.directory, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({ ...another.manifest, format: "other-app" }),
  );
  await expect(restore(another.directory)).rejects.toMatchObject({
    code: "INVALID_BACKUP_ARTIFACT",
  });
});

test("manifest schema/row-count mismatches and extra files are rejected", async () => {
  const artifact = await backup();
  const manifest = path.join(artifact.directory, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      ...artifact.manifest,
      tables: artifact.manifest.tables.map((table) => ({
        ...table,
        rows: table.rows + 1,
      })),
    }),
  );
  await expect(verifyBackup(artifact.directory)).rejects.toMatchObject({
    code: "BACKUP_SCHEMA_MISMATCH",
  });
  await writeFile(manifest, JSON.stringify(artifact.manifest));
  await writeFile(path.join(artifact.directory, "unexpected"), "keep");
  await expect(verifyBackup(artifact.directory)).rejects.toMatchObject({
    code: "INVALID_BACKUP_ARTIFACT",
  });
});

test("non-fog SQLite, non-SQLite and broken foreign-key sources leave no valid backup artifact", async () => {
  const otherPath = path.join(directory, "other.db");
  const other = createClient({ url: `file:${otherPath}` });
  await other.execute("CREATE TABLE other(id TEXT)");
  other.close();
  await expect(
    createBackup({ sourcePath: otherPath, backupDirectory, clock, ids }),
  ).rejects.toMatchObject({ code: "NOT_FOG_DATABASE" });
  expect(await readdir(backupDirectory)).toEqual([]);
  const invalid = path.join(directory, "invalid.db");
  await writeFile(invalid, "not SQLite");
  await expect(
    createBackup({ sourcePath: invalid, backupDirectory, clock, ids }),
  ).rejects.toMatchObject({ code: "NOT_SQLITE_DATABASE" });
  await client.execute("PRAGMA foreign_keys=OFF");
  await client.execute(
    "INSERT INTO fog_memos(id,owner_id,body,created_at,updated_at,version) VALUES('broken','missing','body','date','date',1)",
  );
  await expect(backup()).rejects.toMatchObject({
    code: "DATABASE_FOREIGN_KEYS_FAILED",
  });
  expect(await readdir(backupDirectory)).toEqual([]);
});

test("symlink artifacts/files and unsafe permissions are rejected, and repeated backup IDs never overwrite data", async () => {
  const artifact = await backup();
  const linkPath = path.join(
    backupDirectory,
    artifact.manifest.id.replace(
      /.$/,
      artifact.manifest.id.endsWith("f") ? "e" : "f",
    ),
  );
  if (linkPath === artifact.directory) throw new Error("fixture collision");
  await symlink(artifact.directory, linkPath);
  await expect(verifyBackup(linkPath)).rejects.toMatchObject({
    code: "UNSAFE_DIRECTORY",
  });
  await chmod(path.join(artifact.directory, "snapshot.sqlite"), 0o644);
  await expect(verifyBackup(artifact.directory)).rejects.toMatchObject({
    code: "UNSAFE_FILE",
  });
  await chmod(path.join(artifact.directory, "snapshot.sqlite"), 0o600);
  const fixed = {
    next: () => artifact.manifest.id.slice(-36),
    validate: () => true,
  };
  await expect(
    createBackup({ sourcePath, backupDirectory, clock, ids: fixed }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await verifyBackup(artifact.directory)).toEqual(artifact.manifest);
});

test("retention dry-run and apply delete only expired validated artifacts and always retain the newest valid backup", async () => {
  const oldest = await backup();
  now = new Date(now.getTime() + 10 * 86_400_000);
  const middle = await backup();
  now = new Date(now.getTime() + 10 * 86_400_000);
  const newest = await backup();
  await writeFile(path.join(backupDirectory, "do-not-delete.txt"), "keep");
  const incomplete = path.join(
    backupDirectory,
    `fog-backup-20260101T000000000Z-${ids.next()}`,
  );
  await mkdir(incomplete, { mode: 0o700 });
  await writeFile(path.join(incomplete, "payload"), "keep");
  now = new Date(now.getTime() + 50 * 86_400_000);
  const dry = await pruneBackups({ backupDirectory, retentionDays: 5, clock });
  expect(dry).toMatchObject({ dryRun: true, kept: [newest.manifest.id] });
  expect(dry.deleted.sort()).toEqual(
    [oldest.manifest.id, middle.manifest.id].sort(),
  );
  expect(await readdir(backupDirectory)).toContain(oldest.manifest.id);
  const applied = await pruneBackups({
    backupDirectory,
    retentionDays: 5,
    clock,
    apply: true,
  });
  expect(applied.deleted.sort()).toEqual(dry.deleted.sort());
  expect(await readdir(backupDirectory)).toEqual(
    expect.arrayContaining([
      newest.manifest.id,
      "do-not-delete.txt",
      path.basename(incomplete),
    ]),
  );
  expect(await readFile(path.join(incomplete, "payload"), "utf8")).toBe("keep");
  expect(
    (
      await pruneBackups({
        backupDirectory,
        retentionDays: 5,
        clock,
        apply: true,
      })
    ).deleted,
  ).toEqual([]);
  for (const retentionDays of [0, -1, 0.5, 3651, Number.NaN])
    await expect(
      pruneBackups({ backupDirectory, retentionDays, clock, apply: true }),
    ).rejects.toMatchObject({ code: "INVALID_RETENTION_DAYS" });
  expect(await verifyBackup(newest.directory)).toEqual(newest.manifest);
});

test("backup, restore and prune CLIs run on explicitly supplied paths and reject overwriting", async () => {
  const run = promisify(execFile);
  const cwd = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const execute = (script: string, args: string[]) =>
    run(
      "pnpm",
      [
        "--filter",
        "@repo/web",
        "exec",
        "tsx",
        `scripts/${script}.node.ts`,
        ...args,
      ],
      { cwd },
    );
  const result = await execute("backup", [
    "--source",
    sourcePath,
    "--directory",
    backupDirectory,
  ]);
  const output: unknown = JSON.parse(result.stdout);
  if (
    !output ||
    typeof output !== "object" ||
    !("directory" in output) ||
    typeof output.directory !== "string"
  )
    throw new Error("CLI output");
  const destination = path.join(directory, "cli-restored.db");
  expect(
    JSON.parse(
      (
        await execute("restore", [
          "--backup",
          output.directory,
          "--destination",
          destination,
        ])
      ).stdout,
    ),
  ).toMatchObject({ access: "revoked", destination });
  await expect(
    execute("restore", [
      "--backup",
      output.directory,
      "--destination",
      destination,
    ]),
  ).rejects.toMatchObject({ code: 1 });
  expect(
    JSON.parse(
      (
        await execute("prune-backups", [
          "--directory",
          backupDirectory,
          "--keep-days",
          "30",
        ])
      ).stdout,
    ),
  ).toMatchObject({ dryRun: true, deleted: [] });
}, 20_000);
