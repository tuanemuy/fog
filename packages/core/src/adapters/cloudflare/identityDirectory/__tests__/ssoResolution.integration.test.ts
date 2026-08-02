import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { requireDirectoryRoutingKeyring } from "@repo/core/application/di/secrets";
import {
  type SsoProvider,
  ssoCanonical,
} from "@repo/core/domain/identity/valueObject";
import type { DirectoryLocator } from "@repo/core/lib/directoryLocator";
import { describe, expect, it } from "vitest";
import { createDirectoryLocator } from "../../directoryLocator";
import { runMigrationGate } from "../../schema/gate";
import {
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "../../schema/identityDirectory";
import * as facade from "../facade";
import { createIdentityDirectoryUnitOfWorkProvider } from "../unitOfWork";

/**
 * Resolving a `userId` from an SSO provider and subject.
 *
 * The whole path is exercised — `ssoCanonical` → `forCanonical` → the bucket
 * the locator names → `lookupCredential(kind, hmac)` — because the properties
 * under test are exactly the ones that only appear when the stages are
 * composed: which bucket a canonical lands in, and what happens when two kinds
 * share one.
 *
 * #37 owns no path that *writes* an `kind = 'sso'` mapping (SSO signup and link
 * are #12), so the rows are inserted directly. What is fixed here is the read.
 */

const NOW = 1_800_000_000_000;

const ROUTING_KEYRING = requireDirectoryRoutingKeyring(
  JSON.stringify([
    {
      generation: 1,
      key: "test-directory-routing-secret-0123456789",
      bucketCount: 256,
    },
  ]),
);

const locatorResolver = createDirectoryLocator(ROUTING_KEYRING);

function activeLocator(
  locators: readonly DirectoryLocator[],
): DirectoryLocator {
  const locator = locators[0];
  if (locator === undefined) throw new Error("no locator");
  return locator;
}

let seq = 0;

/**
 * Buckets are addressed by `doName`, but each test needs its own storage, so
 * the name is suffixed. Routing is still computed from the real locator — the
 * suffix only separates the tests from one another.
 */
function inBucket<T>(
  locator: DirectoryLocator,
  fn: (io: { sql: SqlStorage }) => Promise<T> | T,
): Promise<T> {
  const name = `${locator.doName}#${seq}`;
  const ns = env.IDENTITY_DIRECTORY;
  return runInDurableObject(ns.get(ns.idFromName(name)), (_instance, ctx) => {
    const state = ctx as never;
    runMigrationGate(
      state,
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
      locator.doName,
    );
    return fn({ sql: ctx.storage.sql as SqlStorage });
  }) as Promise<T>;
}

function lookupIn<T extends "email" | "sso">(
  locator: DirectoryLocator,
  kind: T,
): Promise<facade.LookupCredentialResult> {
  const name = `${locator.doName}#${seq}`;
  const ns = env.IDENTITY_DIRECTORY;
  return runInDurableObject(ns.get(ns.idFromName(name)), (_instance, ctx) => {
    const state = ctx as never;
    runMigrationGate(
      state,
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
      locator.doName,
    );
    const uow = createIdentityDirectoryUnitOfWorkProvider(
      state,
      { now: () => new Date(NOW) },
      1,
    );
    return facade.lookupCredential(
      { uow },
      {
        kind,
        hmac: locator.hmac,
        generation: locator.generation,
        bucketIndex: locator.bucketIndex,
      },
      NOW,
    );
  }) as Promise<facade.LookupCredentialResult>;
}

function insertMapping(
  sql: SqlStorage,
  args: {
    kind: "email" | "sso";
    hmac: string;
    credentialId: string;
    userId: string;
    passwordVerifier?: string;
  },
): void {
  sql.exec(
    `INSERT INTO credential_mappings (
       credential_id, kind, hmac, generation, user_id, status,
       password_verifier, pending_verifier, change_state, change_origin,
       credential_version, encrypted_canonical, encryption_generation,
       encryption_nonce, failed_attempts, next_attempt_allowed_at,
       last_reset_requested_at, operation_id, candidate_user_id, reserved_until,
       saga_committed, locators, coordinator_locator, caller_token,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, 'active', ?, NULL, NULL, NULL, 3, NULL, NULL,
               NULL, 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL,
               0, 0)`,
    args.credentialId,
    args.kind,
    args.hmac,
    args.userId,
    args.passwordVerifier ?? null,
  );
}

async function locatorFor(canonical: string): Promise<DirectoryLocator> {
  return activeLocator(await locatorResolver.forCanonical(canonical));
}

describe("resolving a userId from an SSO identity", () => {
  it("finds the mapping the canonical routes to", async () => {
    seq += 1;
    const canonical = ssoCanonical("google" as SsoProvider, "sso-subject-4711");
    const locator = await locatorFor(canonical);
    await inBucket(locator, ({ sql }) => {
      insertMapping(sql, {
        kind: "sso",
        hmac: locator.hmac,
        credentialId: "cred-sso",
        userId: "user-sso",
      });
    });
    const found = await lookupIn(locator, "sso");
    expect(found.userId).toBe("user-sso");
    expect(found.credentialId).toBe("cred-sso");
    expect(found.credentialVersion).toBe(3);
    // An SSO row holds no verification material, so there is no work to level
    // and nothing to return in its place.
    expect(found.passwordVerifier).toBeNull();
  });

  it("keeps the same subject on two providers apart", async () => {
    seq += 1;
    const google = await locatorFor(
      ssoCanonical("google" as SsoProvider, "sso-subject-4711"),
    );
    const github = await locatorFor(
      ssoCanonical("github" as SsoProvider, "sso-subject-4711"),
    );
    expect(github.hmac).not.toBe(google.hmac);

    await inBucket(google, ({ sql }) => {
      insertMapping(sql, {
        kind: "sso",
        hmac: google.hmac,
        credentialId: "cred-google",
        userId: "user-google",
      });
    });
    expect((await lookupIn(google, "sso")).userId).toBe("user-google");
    // Registering with one provider must not register the identity with the
    // other: the canonical, and therefore the hmac and usually the bucket, are
    // different values.
    expect((await lookupIn(github, "sso")).userId).toBeNull();
  });

  it("folds the provider's case but not the subject's", async () => {
    seq += 1;
    const lower = ssoCanonical("google" as SsoProvider, "sso-subject-4711");
    const upper = ssoCanonical("GOOGLE" as SsoProvider, "sso-subject-4711");
    expect(upper).toBe(lower);
    // The subject is an opaque value the provider owns; normalising it would
    // put this system's idea of identity out of step with the IdP's.
    const differentSubject = ssoCanonical(
      "google" as SsoProvider,
      "SSO-SUBJECT-4711",
    );
    expect(differentSubject).not.toBe(lower);
  });

  it("lets an email row and an SSO row share a bucket without crossing", async () => {
    seq += 1;
    const sso = await locatorFor(
      ssoCanonical("google" as SsoProvider, "sso-subject-4711"),
    );
    // Placed in the *same* bucket deliberately, with the SSO row's own hmac
    // under `kind = 'email'`: uniqueness is `(kind, hmac)`, so the pair is what
    // separates them, not the bucket and not the hmac alone.
    await inBucket(sso, ({ sql }) => {
      insertMapping(sql, {
        kind: "sso",
        hmac: sso.hmac,
        credentialId: "cred-sso",
        userId: "user-sso",
      });
      insertMapping(sql, {
        kind: "email",
        hmac: sso.hmac,
        credentialId: "cred-email",
        userId: "user-email",
        passwordVerifier: "verifier",
      });
    });
    const asSso = await lookupIn(sso, "sso");
    const asEmail = await lookupIn(sso, "email");
    expect(asSso.userId).toBe("user-sso");
    expect(asSso.passwordVerifier).toBeNull();
    expect(asEmail.userId).toBe("user-email");
    expect(asEmail.passwordVerifier).toBe("verifier");
  });
});
