import { describe, expect, it } from "vitest";
import {
  IDENTITY_DIRECTORY_INDEX_NAMES,
  IDENTITY_DIRECTORY_TABLE_NAMES,
} from "../schema/identityDirectoryPlan";
import {
  USER_DATA_INDEX_NAMES,
  USER_DATA_TABLE_NAMES,
} from "../schema/userDataPlan";
import {
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
} from "./helpers";
import { createTestContainer, registerTestUser } from "./testContainer";

type MasterRow = Readonly<{ name: string; sql: string | null }>;

function tableNames(sql: SqlStorage): Set<string> {
  return new Set(
    sql
      .exec<MasterRow>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
      )
      .toArray()
      .map((row) => row.name)
      .filter(
        (name) =>
          !name.startsWith("search_fts_") && !name.startsWith("sqlite_"),
      ),
  );
}

function indexNames(sql: SqlStorage): Set<string> {
  return new Set(
    sql
      .exec<MasterRow>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index'",
      )
      .toArray()
      // Autoindexes (PRIMARY KEY / UNIQUE) carry no `sql`.
      .filter((row) => row.sql !== null)
      .map((row) => row.name),
  );
}

function schemaVersion(sql: SqlStorage): number {
  return sql
    .exec<{ schema_version: number }>("SELECT schema_version FROM _meta")
    .one().schema_version;
}

let bucketSequence = 0;

/** A bucket no registration ever routes to: generation 9000+ is not in the keyring. */
function freshBucket() {
  bucketSequence += 1;
  return { generation: 9000 + bucketSequence, bucketIndex: 0 };
}

describe("Identity Directory schema v1", () => {
  it("initialises on the first gated RPC with the declared tables and indexes", async () => {
    const { generation, bucketIndex } = freshBucket();
    const stub = directoryStubOf(generation, bucketIndex);

    // Neither diagnostic initialises the object: both are outside the
    // gate's scope and answer an uninitialised bucket as such.
    const before = await stub.readSchemaVersion();
    expect(before).toEqual({ ok: true, value: { schemaVersion: null } });
    expect(await stub.listBucketUserIds()).toEqual({ ok: true, value: [] });
    expect(await stub.readSchemaVersion()).toEqual({
      ok: true,
      value: { schemaVersion: null },
    });

    // The first gated RPC does.
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);

    await inDirectoryStorage(generation, bucketIndex, (sql) => {
      expect(schemaVersion(sql)).toBe(1);
      expect(tableNames(sql)).toEqual(new Set(IDENTITY_DIRECTORY_TABLE_NAMES));
      expect(indexNames(sql)).toEqual(new Set(IDENTITY_DIRECTORY_INDEX_NAMES));
    });
  });
});

describe("User Data schema v1", () => {
  it("is applied by initialize-account together with the declared tables, indexes and the FTS5 table", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    await inUserDataStorage(userId, (sql) => {
      expect(schemaVersion(sql)).toBe(1);
      expect(tableNames(sql)).toEqual(new Set(USER_DATA_TABLE_NAMES));
      expect(indexNames(sql)).toEqual(new Set(USER_DATA_INDEX_NAMES));

      const fts = sql
        .exec<MasterRow>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
        )
        .one();
      expect(fts.sql).toMatch(/fts5/i);
      expect(fts.sql).toMatch(/CREATE VIRTUAL TABLE/i);
    });
  });
});
