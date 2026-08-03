import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../jobs/table";
import { disarm } from "./doHarness";

/**
 * enqueue → alarm → `done`, driven through the **real Durable Object class**.
 *
 * Every other suite calls the runner or a handler directly, which is the right
 * granularity for their subjects but skips the class itself: the migration gate
 * at the head of each entry, the arming that follows an RPC, and the fixed
 * four-step order inside `alarm()`. Those only exist here.
 *
 * **Nothing below asserts on `getAlarm()`.** Measured in this environment, it
 * answers `null` for an alarm that is armed and pending delivery, so it can
 * neither confirm nor refute an arming decision. That is the same unreliability
 * the design cites for keeping the scheduled time on an instance field instead,
 * and the observable that does hold is the one asserted here: the queued work
 * gets run.
 */

type Bucket = {
  requestPasswordReset(
    kind: "email" | "sso",
    hmac: string,
  ): Promise<RpcEnvelope<null>>;
  alarm(): Promise<void>;
};

let seq = 0;

function bucket() {
  seq += 1;
  const ns = env.IDENTITY_DIRECTORY;
  return ns.get(ns.idFromName(`dir:g1:b01${seq}`));
}

/**
 * A reset request, followed immediately by `disarm`.
 *
 * Every case below drives `alarm()` by hand, and the RPC arms a real one a
 * second out — so without this the platform is a second driver of the same
 * queue and the counts below become a race against the wall clock. Routing the
 * call through one helper is what keeps that from being something each case has
 * to remember; see `disarm` for the mechanism.
 */
async function request(
  stub: ReturnType<typeof bucket>,
  hmac: string,
): Promise<RpcEnvelope<null>> {
  const answered = await (stub as unknown as Bucket).requestPasswordReset(
    "email",
    hmac,
  );
  await disarm(stub);
  return answered;
}

/**
 * Ordered by `operation_key`, so `send-mail:…` comes first and the bucket's
 * `sweep-reset-tokens` row second. Every reset request arms both — the sweep is
 * what eventually clears `password_reset_tokens` — so the row count here is two
 * per bucket, not one.
 */
function jobsIn(stub: ReturnType<typeof bucket>): Promise<JobRow[]> {
  return runInDurableObject(stub, (_instance, ctx) =>
    (ctx.storage.sql as SqlStorage)
      .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
      .toArray(),
  ) as Promise<JobRow[]>;
}

/** Pulls every pending row forward so one wake-up drains the bucket. */
function makeAllDue(stub: ReturnType<typeof bucket>): Promise<void> {
  return runInDurableObject(stub, (_instance, ctx) => {
    (ctx.storage.sql as SqlStorage).exec(
      "UPDATE jobs SET next_run_at = 0 WHERE status = 'pending'",
    );
  }) as Promise<void>;
}

function fire(stub: ReturnType<typeof bucket>): Promise<void> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as Bucket).alarm(),
  ) as Promise<void>;
}

/**
 * Fires `alarm()` with `deleteAlarm` counted.
 *
 * `getAlarm()` cannot answer the question — see the note at the top — but the
 * call itself can be observed, and "did the DO delete its alarm" is the half of
 * the fail-closed contract that no other suite reaches through the real entry
 * point.
 *
 * **The count is only evidence if this wake-up is the only one.** A spy on
 * `ctx.storage` sees every call the instance makes, the platform's own
 * deliveries included, so a second wake-up landing inside the window is
 * indistinguishable from the one under test calling twice. That is why every
 * request above goes through `request`, which disarms.
 */
function fireCountingDeletes(stub: ReturnType<typeof bucket>): Promise<number> {
  return runInDurableObject(stub, async (instance, ctx) => {
    const storage = ctx.storage as unknown as {
      deleteAlarm: () => Promise<void>;
    };
    const real = storage.deleteAlarm.bind(storage);
    let deletes = 0;
    storage.deleteAlarm = () => {
      deletes += 1;
      return real();
    };
    try {
      await (instance as unknown as Bucket).alarm();
      return deletes;
    } finally {
      storage.deleteAlarm = real;
    }
  }) as Promise<number>;
}

describe("the Durable Object's alarm entry point", () => {
  it("runs the work an RPC queued, and settles the row", async () => {
    const stub = bucket();
    const answered = await request(stub, "ab".repeat(32));
    expect(answered.ok).toBe(true);
    expect((await jobsIn(stub)).map((row) => row.kind)).toEqual([
      "send-mail",
      "sweep-reset-tokens",
    ]);

    await fire(stub);

    const settled = (await jobsIn(stub))[0];
    expect(settled?.status).toBe("done");
    // One statement writes the terminus: no intermediate shape exists in which
    // the row is finished but still owned.
    expect(settled?.completed_at).not.toBeNull();
    expect(settled?.owner_token).toBeNull();
    expect(settled?.lease_until).toBeNull();
    expect(settled?.next_run_at).toBeNull();
  });

  it("converges a burst of requests onto one row", async () => {
    const stub = bucket();
    for (let i = 0; i < 4; i += 1) {
      await request(stub, "cd".repeat(32));
    }
    // `send-mail` is not a re-arming kind, so once the row is `done` a repeat
    // request does not revive it: wake-ups scale with the throttle window, not
    // with how often somebody asks. The sweep has a per-bucket constant key, so
    // four requests converge on one of those too.
    expect((await jobsIn(stub)).map((row) => row.kind)).toEqual([
      "send-mail",
      "sweep-reset-tokens",
    ]);
  });

  it("tolerates a duplicate delivery of the same alarm", async () => {
    const stub = bucket();
    await request(stub, "ef".repeat(32));
    await fire(stub);
    // At-least-once execution makes this an ordinary occurrence, not an error.
    await fire(stub);
    const rows = await jobsIn(stub);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("done");
  });

  it("never throws out of alarm() when the schema is fail-closed", async () => {
    const stub = bucket();
    await request(stub, "12".repeat(32));
    // Drain the queue first, then re-open the row by hand. Bumping the version
    // with work still runnable would be racing a different question.
    await fire(stub);
    await runInDurableObject(stub, (_instance, ctx) => {
      const sql = ctx.storage.sql as SqlStorage;
      sql.exec("UPDATE _meta SET schema_version = 99");
      sql.exec(
        "UPDATE jobs SET status = 'pending', next_run_at = 0, completed_at = NULL",
      );
    });

    let thrown: unknown;
    try {
      await fire(stub);
    } catch (error) {
      thrown = error;
    }
    // A schema newer than this deployment stops the DO serving, but it must
    // never escape `alarm()`: a throw there gets six platform retries and then
    // the alarm is gone for good.
    expect(thrown).toBeUndefined();

    const rows = await jobsIn(stub);
    // Untouched, and still runnable — the DO re-arms at a fixed interval rather
    // than deleting its alarm and going dormant with work outstanding.
    expect(rows[0]?.status).toBe("pending");
  });

  it("does not delete its alarm when the schema is fail-closed", async () => {
    const stub = bucket();
    await request(stub, "56".repeat(32));
    // Drain what the request queued first. The reset path arms the bucket's
    // `sweep-reset-tokens` two hours out as well, so the runnable set is not
    // empty until that has run too — and an alarm is correctly *kept* while it
    // is outstanding.
    await fire(stub);
    await makeAllDue(stub);
    // Positive control: a wake-up that finds nothing runnable *does* delete the
    // alarm, which is what makes the zero below evidence rather than a spy that
    // was never wired to anything.
    expect(await fireCountingDeletes(stub)).toBe(1);

    await runInDurableObject(stub, (_instance, ctx) => {
      const sql = ctx.storage.sql as SqlStorage;
      sql.exec("UPDATE _meta SET schema_version = 99");
      sql.exec(
        "UPDATE jobs SET status = 'pending', next_run_at = 0, completed_at = NULL",
      );
    });

    // A fail-closed DO has work it cannot run. Deleting the alarm there would
    // make it dormant for good: nothing else re-arms a Durable Object nobody is
    // calling, so the queued job would never run even after a deployment caught
    // the schema up.
    expect(await fireCountingDeletes(stub)).toBe(0);
    expect((await jobsIn(stub))[0]?.status).toBe("pending");
  });

  it("never throws out of alarm() when storage itself fails", async () => {
    const stub = bucket();
    await request(stub, "34".repeat(32));
    // The failure the design actually predicts is a DO at its 10 GB ceiling,
    // where writes fail while reads and deletes still succeed — so `claimJob`
    // throws with no per-job guard around it and `purge-trash`, the only
    // automatic way to free space, can never be claimed again. Removing the
    // table reproduces the same shape: a throw from inside the runner but
    // outside its per-job catch. The gate does not put it back, because the
    // schema version is already current.
    await runInDurableObject(stub, (_instance, ctx) => {
      (ctx.storage.sql as SqlStorage).exec("DROP TABLE jobs");
    });

    let thrown: unknown;
    try {
      await fire(stub);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
  });
});
