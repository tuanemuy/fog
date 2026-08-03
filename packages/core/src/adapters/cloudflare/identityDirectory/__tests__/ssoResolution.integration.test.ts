import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { LookupCredentialResult } from "@repo/core/application/di/facades";
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
 * No write path for a `kind = 'sso'` mapping exists yet, so the rows are
 * inserted directly. What is under test is the read.
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
): Promise<LookupCredentialResult> {
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
    const uow = createIdentityDirectoryUnitOfWorkProvider(state, {
      now: () => new Date(NOW),
    });
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
  }) as Promise<LookupCredentialResult>;
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

/** The resolved `userId`, or `null` for the levelled answer. */
function userIdOf(result: LookupCredentialResult): string | null {
  return result.outcome === "none" ? null : result.userId;
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
    // An SSO row holds no verification material, so there is no work to level.
    // The arm says so; there is no nullable `passwordVerifier` to inspect.
    expect(found.outcome).toBe("identity");
    expect(userIdOf(found)).toBe("user-sso");
    expect(found.outcome !== "none" && found.credentialId).toBe("cred-sso");
    expect(found.credentialVersion).toBe(3);
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
    expect(userIdOf(await lookupIn(google, "sso"))).toBe("user-google");
    // Registering with one provider must not register the identity with the
    // other: the canonical, and therefore the hmac and usually the bucket, are
    // different values.
    expect(userIdOf(await lookupIn(github, "sso"))).toBeNull();
  });

  it("resolves a differently-cased provider onto the row a lower-cased one wrote", async () => {
    seq += 1;
    // What only the composed path can show: `valueObject.test.ts` already pins
    // that `ssoCanonical` folds the provider's case and leaves the subject's
    // alone, but not that the folded value is what reaches the bucket. A
    // lookup that hashed the provider as typed would miss this row while every
    // value-object test stayed green.
    const written = await locatorFor(
      ssoCanonical("google" as SsoProvider, "sso-subject-4711"),
    );
    await inBucket(written, ({ sql }) => {
      insertMapping(sql, {
        kind: "sso",
        hmac: written.hmac,
        credentialId: "cred-sso",
        userId: "user-sso",
      });
    });

    const asTyped = await locatorFor(
      ssoCanonical("GOOGLE" as SsoProvider, "sso-subject-4711"),
    );
    expect(asTyped.doName).toBe(written.doName);
    expect(userIdOf(await lookupIn(asTyped, "sso"))).toBe("user-sso");

    // The subject is an opaque value the provider owns; normalising it would
    // put this system's idea of identity out of step with the IdP's — so a
    // re-cased subject is a *different* identity and resolves to nothing.
    const recasedSubject = await locatorFor(
      ssoCanonical("google" as SsoProvider, "SSO-SUBJECT-4711"),
    );
    expect(recasedSubject.hmac).not.toBe(written.hmac);
    expect(userIdOf(await lookupIn(recasedSubject, "sso"))).toBeNull();
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
    expect(asSso.outcome).toBe("identity");
    expect(userIdOf(asSso)).toBe("user-sso");
    expect(asEmail.outcome).toBe("password");
    expect(userIdOf(asEmail)).toBe("user-email");
    expect(asEmail.outcome === "password" && asEmail.passwordVerifier).toBe(
      "verifier",
    );
  });
});
