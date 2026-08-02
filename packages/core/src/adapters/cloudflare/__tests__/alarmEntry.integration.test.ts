import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../jobs/table";

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

function jobsIn(stub: ReturnType<typeof bucket>): Promise<JobRow[]> {
  return runInDurableObject(stub, (_instance, ctx) =>
    (ctx.storage.sql as SqlStorage)
      .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
      .toArray(),
  ) as Promise<JobRow[]>;
}

function fire(stub: ReturnType<typeof bucket>): Promise<void> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as Bucket).alarm(),
  ) as Promise<void>;
}

describe("the Durable Object's alarm entry point", () => {
  it("runs the work an RPC queued, and settles the row", async () => {
    const stub = bucket();
    const answered = await (stub as unknown as Bucket).requestPasswordReset(
      "email",
      "ab".repeat(32),
    );
    expect(answered.ok).toBe(true);
    expect(await jobsIn(stub)).toHaveLength(1);

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
      await (stub as unknown as Bucket).requestPasswordReset(
        "email",
        "cd".repeat(32),
      );
    }
    // `send-mail` is not a re-arming kind, so once the row is `done` a repeat
    // request does not revive it: wake-ups scale with the throttle window, not
    // with how often somebody asks.
    expect(await jobsIn(stub)).toHaveLength(1);
  });

  it("tolerates a duplicate delivery of the same alarm", async () => {
    const stub = bucket();
    await (stub as unknown as Bucket).requestPasswordReset(
      "email",
      "ef".repeat(32),
    );
    await fire(stub);
    // At-least-once execution makes this an ordinary occurrence, not an error.
    await fire(stub);
    const rows = await jobsIn(stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
  });

  it("never throws out of alarm() when the schema is fail-closed", async () => {
    const stub = bucket();
    await (stub as unknown as Bucket).requestPasswordReset(
      "email",
      "12".repeat(32),
    );
    // Let the platform's own delivery happen first, then re-open the row by
    // hand. Bumping the version while an alarm was still in flight would be
    // racing a different question.
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
});
