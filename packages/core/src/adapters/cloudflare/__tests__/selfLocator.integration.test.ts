import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserDataDurableObject } from "../userDataDurableObject";
import { inUserDataStorage, userDataStubOf } from "./helpers";
import { createTestContainer, registerTestUser } from "./testContainer";

type JobRow = Readonly<{ status: string; terminal_reason: string | null }>;

/**
 * Takes the name away from a live instance, the way the local workerd
 * hands an object back to fire its Alarm after a restart (PH-06
 * verification O-2). The field is `readonly` for the class's own code;
 * the harness is the one place it is overwritten.
 */
async function forgetName(userId: string): Promise<void> {
  await runInDurableObject(userDataStubOf(userId), (instance) => {
    (
      instance as unknown as { selfLocatorValue: string | undefined }
    ).selfLocatorValue = undefined;
    (
      instance as unknown as { storedSelfLocator: string | null }
    ).storedSelfLocator = null;
  });
}

describe("an object reached without its name resolves its locator from _meta", () => {
  it("answers a read entry and runs its due job through alarm()", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await inUserDataStorage(userId, async (sql, _instance, state) => {
      sql.exec(
        `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
         VALUES ('sweep-orphan-mapping', 'sweep-orphan-mapping', '{}', '{}', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
        Date.now() - 1_000,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await forgetName(userId);

    // A stub built from the id alone carries no name either.
    const unnamed = env.USER_DATA.get(
      env.USER_DATA.idFromString(userDataStubOf(userId).id.toString()),
    ) as unknown as UserDataDurableObject;
    const account = await unnamed.readAccountState();
    expect(account.ok).toBe(true);
    if (!account.ok) throw new Error("unreachable");
    expect(account.value?.status).toBe("active");

    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
    const job = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<JobRow>(
          "SELECT status, terminal_reason FROM jobs WHERE operation_key = 'sweep-orphan-mapping'",
        )
        .one(),
    );
    expect(job.status).toBe("done");
    expect(job.terminal_reason).toBeNull();
  });

  it("an object with neither a name nor a _meta row is NotInitialized", async () => {
    const fresh = env.USER_DATA.get(
      env.USER_DATA.idFromString(
        env.USER_DATA.idFromName(
          "01950000-0000-7000-8000-0000000000ff",
        ).toString(),
      ),
    ) as unknown as UserDataDurableObject;
    await runInDurableObject(
      fresh as unknown as DurableObjectStub,
      (instance) => {
        (
          instance as unknown as { selfLocatorValue: string | undefined }
        ).selfLocatorValue = undefined;
      },
    );
    const answer = await fresh.readAccountState();
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("unreachable");
    expect(answer.error.code).toBe("NOT_INITIALIZED");
  });
});
