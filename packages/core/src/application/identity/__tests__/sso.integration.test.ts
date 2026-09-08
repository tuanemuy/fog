import { runDurableObjectAlarm } from "cloudflare:test";
import {
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  testKeyring,
  uniqueEmail,
  userDataStubOf,
} from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { activeKey } from "@repo/core/adapters/cloudflare/crypto/keyring";
import { deriveLocator } from "@repo/core/adapters/cloudflare/crypto/locatorDerivation";
import { isConflictError } from "@repo/core/application/errors";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { getCurrentUser } from "../getCurrentUser";
import {
  resumeLinkOperationKey,
  SWEEP_ORPHAN_MAPPING_OPERATION_KEY,
} from "../jobKeys";
import { linkSsoCredential } from "../linkSsoCredential";
import { loginWithPassword } from "../loginWithPassword";
import {
  registerOrLoginWithSso,
  ssoCanonicalOf,
} from "../registerOrLoginWithSso";
import { registerWithPassword } from "../registerWithPassword";
import { unlinkSsoCredential } from "../unlinkSsoCredential";

type MappingRow = Readonly<{
  credential_id: string;
  kind: string;
  status: string;
  user_id: string | null;
  password_verifier: string | null;
  saga_committed: number | null;
}>;

type LocatorRow = Readonly<{
  credential_id: string;
  kind: string;
  usable_for_login: number;
  label: string;
}>;

type OperationRow = Readonly<{
  operation_id: string;
  kind: string;
  phase: string;
}>;

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  terminal_reason: string | null;
}>;

async function expectCode<TGuard extends (error: unknown) => boolean>(
  promise: Promise<unknown>,
  guard: TGuard,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(guard(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

async function ssoBucket(provider: string, subject: string) {
  const locator = await deriveLocator(
    activeKey(testKeyring),
    "sso",
    ssoCanonicalOf(provider, subject),
  );
  return {
    generation: locator.generation,
    bucketIndex: locator.bucketIndex,
    hmac: locator.hmac,
  };
}

async function ssoMapping(provider: string, subject: string) {
  const bucket = await ssoBucket(provider, subject);
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<MappingRow>(
          "SELECT credential_id, kind, status, user_id, password_verifier, saga_committed FROM credential_mappings WHERE kind = 'sso' AND hmac = ?",
          bucket.hmac,
        )
        .toArray()[0],
  );
}

async function emailMapping(email: string) {
  const bucket = await bucketOfEmail(email);
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<MappingRow>(
          "SELECT credential_id, kind, status, user_id, password_verifier, saga_committed FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
          bucket.hmac,
        )
        .toArray()[0],
  );
}

async function userSide(userId: string) {
  return inUserDataStorage(userId, (sql) => ({
    locators: sql
      .exec<LocatorRow>(
        "SELECT credential_id, kind, usable_for_login, label FROM credential_locators ORDER BY kind",
      )
      .toArray(),
    operations: sql
      .exec<OperationRow>(
        "SELECT operation_id, kind, phase FROM operations ORDER BY created_at",
      )
      .toArray(),
    jobs: sql
      .exec<JobRow>(
        "SELECT operation_key, kind, status, terminal_reason FROM jobs",
      )
      .toArray(),
    epoch: sql
      .exec<{ session_epoch: number }>("SELECT session_epoch FROM account")
      .one().session_epoch,
  }));
}

async function runUserJob(userId: string, operationKey: string) {
  await inUserDataStorage(userId, async (sql, _instance, state) => {
    sql.exec(
      "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
      Date.now() - 1_000,
      operationKey,
    );
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
  return (await userSide(userId)).jobs.find(
    (job) => job.operation_key === operationKey,
  );
}

describe("registerOrLoginWithSso", () => {
  it("signs up with two active rows, logs the same subject in afterwards, and never auto-links a held address", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const subject = `sub-${email}`;

    const first = await registerOrLoginWithSso({
      container,
      input: { provider: "google", providerSubject: subject, email },
    });
    expect(first.isNewUser).toBe(true);

    const sso = await ssoMapping("google", subject);
    expect(sso?.status).toBe("active");
    expect(sso?.user_id).toBe(first.userId);
    expect(sso?.saga_committed).toBe(1);
    const mail = await emailMapping(email);
    expect(mail?.status).toBe("active");
    expect(mail?.user_id).toBe(first.userId);
    expect(mail?.password_verifier).toBeNull();

    const side = await userSide(first.userId);
    expect(side.locators).toEqual([
      expect.objectContaining({
        kind: "email",
        usable_for_login: 0,
        label: "",
      }),
      expect.objectContaining({
        kind: "sso",
        usable_for_login: 1,
        label: "google",
      }),
    ]);
    expect(side.operations).toEqual([
      expect.objectContaining({ kind: "signup", phase: "done" }),
    ]);
    const view = await getCurrentUser({
      container,
      input: { userId: first.userId },
    });
    expect(view.email).toBe(email);
    expect(view.credentials.map((c) => [c.kind, c.usableForLogin])).toEqual([
      ["sso", true],
      ["email", false],
    ]);

    const again = await registerOrLoginWithSso({
      container,
      input: {
        provider: "google",
        providerSubject: subject,
        email: "other@example.com",
      },
    });
    expect(again).toEqual({ userId: first.userId, isNewUser: false });

    // The SSO user's address cannot register with a password, and its email
    // row is not a login method.
    await expectCode(
      registerWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      isConflictError,
      "EMAIL_ALREADY_REGISTERED",
    );
    await expectCode(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      (e) => (e as { code?: string }).code === "INVALID_CREDENTIALS",
      "INVALID_CREDENTIALS",
    );
  });

  it("refuses a password user's address and hands the subject reservation back", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    await registerTestUser(container, { email });
    const subject = `sub-${email}`;
    await expectCode(
      registerOrLoginWithSso({
        container,
        input: { provider: "google", providerSubject: subject, email },
      }),
      isConflictError,
      "EMAIL_ALREADY_REGISTERED",
    );
    expect(await ssoMapping("google", subject)).toBeUndefined();
    // The handed-back coordinator's resume-signup has nothing to re-drive
    // and must not run to `poison`: it is closed with the reservation.
    const bucket = await ssoBucket("google", subject);
    const jobs = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<JobRow>(
            "SELECT operation_key, kind, status, terminal_reason FROM jobs WHERE kind = 'resume-signup' AND json_extract(payload, '$.locator.hmac') = ?",
            bucket.hmac,
          )
          .toArray(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("done");
  });

  it("re-driving the two-credential saga through resume-signup is idempotent", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const subject = `sub-${email}`;
    const { userId } = await registerOrLoginWithSso({
      container,
      input: { provider: "google", providerSubject: subject, email },
    });
    const before = await userSide(userId);
    const bucket = await ssoBucket("google", subject);
    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE kind = 'resume-signup'",
          Date.now() - 1_000,
        );
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    expect(
      await runDurableObjectAlarm(
        directoryStubOf(bucket.generation, bucket.bucketIndex),
      ),
    ).toBe(true);
    // Buckets are shared across the suites, so the row is picked by the
    // locator its payload names, not by kind alone.
    const job = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<JobRow>(
            "SELECT operation_key, kind, status, terminal_reason FROM jobs WHERE kind = 'resume-signup' AND json_extract(payload, '$.locator.hmac') = ?",
            bucket.hmac,
          )
          .one(),
    );
    expect(job.status).toBe("done");
    expect(job.terminal_reason).toBeNull();
    expect(await userSide(userId)).toEqual(before);
  });
});

describe("linkSsoCredential / unlinkSsoCredential", () => {
  it("links a subject to a password account, refuses it for another, unlinks it and sweeps", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const other = await registerTestUser(container);
    const subject = `link-${email}`;

    const { credentialId } = await linkSsoCredential({
      container,
      input: { userId, provider: "google", providerSubject: subject },
    });
    const linked = await userSide(userId);
    expect(linked.locators.map((l) => l.kind)).toEqual(["email", "sso"]);
    expect(linked.operations.map((o) => [o.kind, o.phase])).toEqual([
      ["signup", "done"],
      ["link", "done"],
    ]);
    // The epoch does not move on a link.
    expect(linked.epoch).toBe((await userSide(userId)).epoch);
    expect((await ssoMapping("google", subject))?.user_id).toBe(userId);
    const linkJob = linked.jobs.find((j) => j.kind === "resume-link");
    expect(linkJob?.status).toBe("pending");
    // The subject now logs in as this account.
    expect(
      await registerOrLoginWithSso({
        container,
        input: {
          provider: "google",
          providerSubject: subject,
          email: "x@example.com",
        },
      }),
    ).toEqual({ userId, isNewUser: false });

    await expectCode(
      linkSsoCredential({
        container,
        input: {
          userId: other.userId,
          provider: "google",
          providerSubject: subject,
        },
      }),
      isConflictError,
      "SSO_IDENTITY_ALREADY_REGISTERED",
    );
    expect(
      (await userSide(other.userId)).operations.map((o) => [o.kind, o.phase]),
    ).toEqual([
      ["signup", "done"],
      ["link", "done"],
    ]);

    // The completed link's fallback finds nothing to do.
    expect(
      (await runUserJob(userId, linkJob?.operation_key ?? ""))?.status,
    ).toBe("done");

    const epochBefore = (await userSide(userId)).epoch;
    await unlinkSsoCredential({ container, input: { userId, credentialId } });
    const unlinked = await userSide(userId);
    expect(unlinked.locators.map((l) => l.kind)).toEqual(["email"]);
    expect(unlinked.epoch).toBe(epochBefore + 1);
    expect(unlinked.operations.at(-1)).toMatchObject({
      kind: "unlink",
      phase: "done",
    });
    expect(await ssoMapping("google", subject)).toBeUndefined();
    const view = await getCurrentUser({ container, input: { userId } });
    expect(view.credentials.map((c) => c.kind)).toEqual(["email"]);

    // The sweep finds no open record and finishes.
    const sweep = await runUserJob(userId, SWEEP_ORPHAN_MAPPING_OPERATION_KEY);
    expect(sweep?.status).toBe("done");
  });

  it("refuses to unlink the last login method and an email credential", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerOrLoginWithSso({
      container,
      input: { provider: "google", providerSubject: `only-${email}`, email },
    });
    const view = await getCurrentUser({ container, input: { userId } });
    const sso = view.credentials.find((c) => c.kind === "sso");
    const mail = view.credentials.find((c) => c.kind === "email");
    await expectCode(
      unlinkSsoCredential({
        container,
        input: { userId, credentialId: sso?.credentialId ?? "" },
      }),
      isBusinessRuleError,
      "LAST_CREDENTIAL_REMOVAL",
    );
    await expectCode(
      unlinkSsoCredential({
        container,
        input: { userId, credentialId: mail?.credentialId ?? "" },
      }),
      isBusinessRuleError,
      "LAST_CREDENTIAL_REMOVAL",
    );
    expect((await userSide(userId)).locators).toHaveLength(2);
  });

  it("resume-link finishes a link the request left after the reservation", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const subject = `stalled-${email}`;
    const gateway = container.identityGateway;
    const credentialId = container.idGenerator.next();
    const operationId = container.idGenerator.next();
    const locator = await gateway.deriveCredentialLocator(
      "sso",
      ssoCanonicalOf("google", subject),
      credentialId,
    );
    const { callerToken } = await gateway.beginLink(userId, {
      operationId,
      credentialId,
      locator,
      label: "google",
    });
    await gateway.reserveCredential(locator, {
      operationId,
      candidateUserId: userId,
      callerToken,
      canonical: ssoCanonicalOf("google", subject),
      passwordVerifier: null,
      reservedUntil: new Date(Date.now() + 3_600_000),
      coordinator: { role: "coordinator", locators: [locator] },
    });
    // The request died here: reserved, not activated, record open.
    expect((await ssoMapping("google", subject))?.status).toBe("reserved");

    const job = await runUserJob(userId, resumeLinkOperationKey(operationId));
    expect(job?.status).toBe("done");
    expect(job?.terminal_reason).toBeNull();
    const side = await userSide(userId);
    expect(side.locators.map((l) => [l.kind, l.label])).toEqual([
      ["email", ""],
      ["sso", "google"],
    ]);
    expect(side.operations.at(-1)).toMatchObject({
      kind: "link",
      phase: "done",
    });
    expect((await ssoMapping("google", subject))?.status).toBe("active");
    expect((await ssoMapping("google", subject))?.user_id).toBe(userId);
  });

  it("sweep-orphan-mapping deletes the rows of an unlink the request could not finish", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const subject = `orphan-${email}`;
    const { credentialId } = await linkSsoCredential({
      container,
      input: { userId, provider: "google", providerSubject: subject },
    });
    // Only phase 1 ran: the User Data side is final, the bucket row remains.
    const operationId = container.idGenerator.next();
    await container.identityGateway.beginUnlink(userId, {
      operationId,
      credentialId,
    });
    expect((await ssoMapping("google", subject))?.status).toBe("active");
    expect((await userSide(userId)).operations.at(-1)).toMatchObject({
      kind: "unlink",
      phase: "deleting",
    });

    const job = await runUserJob(userId, SWEEP_ORPHAN_MAPPING_OPERATION_KEY);
    expect(job?.status).toBe("done");
    expect(await ssoMapping("google", subject)).toBeUndefined();
    expect((await userSide(userId)).operations.at(-1)).toMatchObject({
      kind: "unlink",
      phase: "done",
    });
  });
});
