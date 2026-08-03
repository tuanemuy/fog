import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { enqueueJob } from "@repo/core/adapters/cloudflare/jobs/table";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import { IdentityDirectoryDurableObject } from "../identityDirectory";
import { UserDataDurableObject } from "../userData";

/**
 * AC-16 (i), read off the Durable Object classes themselves.
 *
 * The claim is that the migration gate sits at the head of **every** RPC entry,
 * with exactly two exemptions — the operator diagnostics `read-schema-version`
 * and `list-bucket-user-ids`, which have to keep answering precisely when the
 * gate refuses to let anything else through. Every entry is actually called on
 * a Durable Object whose `schema_version` is ahead of this deployment, and the
 * two exemptions are called on the same one — reading the source cannot show
 * that.
 *
 * The membership of the two lists is also checked against the class's own
 * prototype, so adding an entry without deciding which side it belongs on
 * fails here rather than passing unnoticed.
 */

const AHEAD = 99;
const HMAC = "ab".repeat(32);
/** Far enough ahead that the platform never delivers it during the run. */
const ARMED_AT = 4_000_000_000_000;
const FAIL_CLOSED = "Schema version is newer than this deployment";

/** Everything on the prototype that is not an RPC entry. */
const INTERNALS = [
  "constructor",
  "alarm",
  "entry",
  "gate",
  "state",
  "now",
  "sql",
  "selfLocator",
];

type Envelope = RpcEnvelope<unknown>;
type Entry = (stub: never) => Promise<Envelope> | Envelope;

let seq = 0;

function methodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => !INTERNALS.includes(name))
    .sort();
}

/**
 * Puts the Durable Object one schema version ahead of this deployment, after
 * letting it create its schema normally.
 */
async function failClosed(
  namespace: DurableObjectNamespace,
  bootstrap: (stub: never) => Promise<Envelope>,
): Promise<DurableObjectStub> {
  seq += 1;
  const stub = namespace.get(namespace.idFromName(`entries-${seq}`));
  await bootstrap(stub as never);
  await runInDurableObject(stub, (_instance, ctx) => {
    (ctx.storage.sql as SqlStorage).exec(
      "UPDATE _meta SET schema_version = ?",
      AHEAD,
    );
  });
  return stub;
}

async function refusals(
  stub: DurableObjectStub,
  entries: Readonly<Record<string, Entry>>,
): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  for (const [name, call] of Object.entries(entries)) {
    const envelope = await call(stub as never);
    seen[name] = envelope.ok ? "answered" : `refused:${envelope.error.message}`;
  }
  return seen;
}

const USER_DATA_ENTRIES: Readonly<Record<string, Entry>> = {
  getCurrentUser: (stub: never) =>
    (stub as UserDataDurableObject).getCurrentUser("user-1", 0),
  changeTrashRetentionDays: (stub: never) =>
    (stub as UserDataDurableObject).changeTrashRetentionDays("user-1", 0, 7),
  initializeAccount: (stub: never) =>
    (stub as UserDataDurableObject).initializeAccount({
      userId: "user-1",
      operationId: "op-1",
      payloadDigest: "digest",
      callerToken: "caller",
      targetLocators: [],
    }),
  verifyLogin: (stub: never) =>
    (stub as UserDataDurableObject).verifyLogin({
      userId: "user-1",
      credentialId: "cred-1",
      credentialVersion: 0,
    }),
  recordCredentialLocator: (stub: never) =>
    (stub as UserDataDurableObject).recordCredentialLocator({
      operationId: "op-1",
      payloadDigest: "digest",
      callerToken: "caller",
      credentialId: "cred-1",
      kind: "email",
      hmac: HMAC,
      generation: 1,
      bucketIndex: 1,
      credentialVersion: 0,
      usableForLogin: true,
      label: "",
    }),
};

const DIRECTORY_ENTRIES: Readonly<Record<string, Entry>> = {
  lookupCredential: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).lookupCredential({
      kind: "email",
      hmac: HMAC,
      generation: 1,
      bucketIndex: 1,
    }),
  reportLoginResult: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).reportLoginResult(
      "email",
      HMAC,
      false,
    ),
  reserveCredential: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).reserveCredential({
      kind: "email",
      hmac: HMAC,
      generation: 1,
      credentialId: "cred-1",
      canonical: "user@example.com",
      candidateUserId: "user-1",
      operationId: "op-1",
      callerToken: "caller",
      reservedUntil: 4_000_000_000_000,
      isCoordinator: true,
    }),
  activateReservation: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).activateReservation(
      "email",
      HMAC,
      "op-1",
      "user-1",
      "caller",
    ),
  cancelReservation: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).cancelReservation(
      "email",
      HMAC,
      "op-1",
      "caller",
    ),
  checkPreviousGeneration: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).checkPreviousGeneration(
      "email",
      HMAC,
    ),
  requestPasswordReset: (stub: never) =>
    (stub as IdentityDirectoryDurableObject).requestPasswordReset(
      "email",
      HMAC,
    ),
};

describe("UserDataDurableObject's RPC entries", () => {
  it("lists exactly the entries this file exercises", () => {
    expect(methodNames(UserDataDurableObject.prototype)).toEqual(
      [...Object.keys(USER_DATA_ENTRIES), "readSchemaVersion"].sort(),
    );
  });

  it("fails every gated entry closed when the schema is ahead", async () => {
    const stub = await failClosed(env.USER_DATA, (s) =>
      (s as UserDataDurableObject).getCurrentUser("user-1", 0),
    );
    const seen = await refusals(stub, USER_DATA_ENTRIES);
    const expected = Object.fromEntries(
      Object.keys(USER_DATA_ENTRIES).map((name) => [
        name,
        `refused:${FAIL_CLOSED}`,
      ]),
    );
    // Compared as one object rather than entry by entry: an entry that answered
    // — or that refused for its own reasons before reaching the gate — shows up
    // as a diff naming itself.
    expect(seen).toEqual(expected);
  });

  it("keeps answering read-schema-version while fail-closed", async () => {
    const stub = await failClosed(env.USER_DATA, (s) =>
      (s as UserDataDurableObject).getCurrentUser("user-1", 0),
    );
    // The exemption exists for exactly this moment: the diagnostic that tells
    // an operator *why* the Durable Object is refusing must not be refused by
    // the thing it is diagnosing.
    const envelope = await (
      stub as unknown as UserDataDurableObject
    ).readSchemaVersion();
    expect(envelope.ok).toBe(true);
    expect(envelope.ok && envelope.value).toBe(AHEAD);
  });
});

describe("IdentityDirectoryDurableObject's RPC entries", () => {
  it("lists exactly the entries this file exercises", () => {
    expect(methodNames(IdentityDirectoryDurableObject.prototype)).toEqual(
      [
        ...Object.keys(DIRECTORY_ENTRIES),
        "readSchemaVersion",
        "listBucketUserIds",
      ].sort(),
    );
  });

  it("fails every gated entry closed when the schema is ahead", async () => {
    const stub = await failClosed(env.IDENTITY_DIRECTORY, (s) =>
      (s as IdentityDirectoryDurableObject).checkPreviousGeneration(
        "email",
        HMAC,
      ),
    );
    const seen = await refusals(stub, DIRECTORY_ENTRIES);
    const expected = Object.fromEntries(
      Object.keys(DIRECTORY_ENTRIES).map((name) => [
        name,
        `refused:${FAIL_CLOSED}`,
      ]),
    );
    expect(seen).toEqual(expected);
  });

  it("keeps answering both diagnostics while fail-closed", async () => {
    const stub = await failClosed(env.IDENTITY_DIRECTORY, (s) =>
      (s as IdentityDirectoryDurableObject).checkPreviousGeneration(
        "email",
        HMAC,
      ),
    );
    const directory = stub as unknown as IdentityDirectoryDurableObject;
    const version = await directory.readSchemaVersion();
    expect(version.ok).toBe(true);
    expect(version.ok && version.value).toBe(AHEAD);

    const ids = await directory.listBucketUserIds(null, 10);
    expect(ids.ok).toBe(true);
    expect(ids.ok && ids.value).toEqual([]);
  });

  /**
   * AC-12 (iii) for **this class**.
   *
   * The arming wrapper itself is covered by
   * `jobs/__tests__/alarm.integration.test.ts`'s "the RPC entry wrapper", and
   * the User Data class's use of it by `cleanup.integration.test.ts` — which
   * left "the Directory class goes through `runRpcEntry`" as the one link
   * nothing observed. Measured: replacing `entry()` with a hand-written gate and
   * envelope that never arms leaves the whole integration suite green.
   *
   * The arm is read with `getAlarm()`, which is only sound because the queued
   * time is far away. An alarm armed for the next second comes back `null` here
   * (and would be delivered mid-test); one armed for 2096 comes back exactly —
   * the same trick, and the same constant, `cleanup.integration.test.ts` uses.
   * Nothing needs `disarm` for that reason either.
   */
  it("arms the alarm its queue asks for on the way out of a gated entry", async () => {
    seq += 1;
    const ns = env.IDENTITY_DIRECTORY;
    const stub = ns.get(ns.idFromName(`entries-arming-${seq}`));
    const directory = stub as unknown as IdentityDirectoryDurableObject;
    // Creates the schema. Nothing is queued yet, so nothing is armed yet.
    await directory.checkPreviousGeneration("email", HMAC);
    await runInDurableObject(stub, (_instance, ctx) => {
      enqueueJob(ctx.storage.sql as SqlStorage, 0, {
        kind: "sweep-reservations",
        operationKey: "sweep-reservations",
        payload: {},
        nextRunAt: ARMED_AT,
      });
    });
    const before = await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.getAlarm(),
    );

    const envelope = await directory.checkPreviousGeneration("email", HMAC);

    const after = await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.getAlarm(),
    );
    expect(envelope.ok).toBe(true);
    // `before` is the control: the row alone arms nothing, so the alarm below is
    // the entry's doing rather than `enqueueJob`'s.
    expect(before).toBeNull();
    expect(after).toBe(ARMED_AT);
  });
});
