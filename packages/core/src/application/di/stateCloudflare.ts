import type {
  DurableObjectNamespace,
  DurableObjectState,
  Fetcher,
} from "@cloudflare/workers-types";
import type { IdentityDirectoryFacadeDeps } from "@repo/core/adapters/cloudflare/identityDirectory/facade";
import { createIdentityDirectoryUnitOfWorkProvider } from "@repo/core/adapters/cloudflare/identityDirectory/unitOfWork";
import {
  createBindingMailSender,
  createNoopMailSender,
} from "@repo/core/adapters/cloudflare/mailSender";
import type { UserDataFacadeDeps } from "@repo/core/adapters/cloudflare/userData/facade";
import { createUserDataUnitOfWorkProvider } from "@repo/core/adapters/cloudflare/userData/unitOfWork";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { requireKeyring, type StateSecrets } from "./secrets";
import type { SharedDeps } from "./types";

/**
 * Bindings the state Worker hands to the Durable Object classes.
 *
 * Deliberately narrow, and the omission is the point: **`DIRECTORY_ROUTING_SECRET`
 * is not here**. Canonicalisation and HMAC derivation belong to the request
 * Worker, and giving a bucket the routing secret would let it reconstruct its
 * own name from an address — the exact property the design spends the HMAC to
 * remove (ADR-016).
 */
export type StateEnv = Readonly<{
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
  APP_URL: string;
  /** Absent in local development and in the integration suite. */
  MAIL_SENDER?: Fetcher;
  IDENTITY_MAIL_ENCRYPTION_KEY?: string;
  IDENTITY_RESET_TOKEN_KEY?: string;
}>;

/**
 * Re-exported, never restated. Two structurally identical declarations would
 * split silently the first time a key is added to one of them: `registry.ts`
 * reads the type from `secrets.ts` while the Durable Object builds its value
 * here, and nothing would report the mismatch.
 */
export type { StateSecrets } from "./secrets";

export type UserDataContainer = SharedDeps &
  UserDataFacadeDeps &
  Readonly<{ appUrl: string }>;

export type IdentityDirectoryContainer = SharedDeps &
  IdentityDirectoryFacadeDeps &
  Readonly<{ appUrl: string; mailSender: MailSender }>;

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/**
 * Built from a Durable Object's constructor, which only retains `ctx` / `env` —
 * no I/O, no randomness, no timers. **No `AsyncLocalStorage`**: one instance is
 * one user (or one bucket), so there is no ambient scope to propagate, and
 * `getContainer()` — which is request-scoped — must never be called from here.
 */
export function createUserDataContainer(
  ctx: DurableObjectState,
  env: StateEnv,
): UserDataContainer {
  const shared = buildSharedDeps();
  return {
    ...shared,
    appUrl: env.APP_URL,
    uow: createUserDataUnitOfWorkProvider(ctx, shared.clock),
  };
}

export function createIdentityDirectoryContainer(
  ctx: DurableObjectState,
  env: StateEnv,
): IdentityDirectoryContainer {
  const shared = buildSharedDeps();
  return {
    ...shared,
    appUrl: env.APP_URL,
    // Unbound `MAIL_SENDER` falls back to the noop, which warns on every call.
    // Silently dropping mail in production is the failure mode this makes
    // impossible to miss (ADR-007).
    mailSender:
      env.MAIL_SENDER === undefined
        ? createNoopMailSender(shared.logger)
        : createBindingMailSender(env.MAIL_SENDER, env.APP_URL, shared.logger),
    // No reset-token generation is threaded through here. The generation is
    // decided where the token is derived — the RPC entry point, which reads the
    // keyring itself — and travels to the row as part of the issue material
    // (ADR-042). Reading a keyring in a Durable Object's constructor would also
    // mean an unset optional binding could take `alarm()` down with it.
    uow: createIdentityDirectoryUnitOfWorkProvider(ctx, shared.clock),
  };
}

/**
 * The state Worker's secrets, validated strictly. Held in their own object and
 * never merged into a container's public surface, for the same reason the
 * request side nests `RequestSecrets`: a flat placement rides a rest-spread out
 * of the module.
 */
/**
 * The same secrets, for a caller that must not be taken down by an unset
 * optional binding — the Durable Object's `alarm()`, which may never throw.
 *
 * `null` means "this deployment binds neither key". A job that actually needs
 * one then fails on its own, loudly, and lands in `poison` with a reason; the
 * DO keeps serving everything else. Returning a silently empty keyring instead
 * would let a reset mail be recorded as sent when nothing left the building.
 */
export function readStateSecretsOrNull(env: StateEnv): StateSecrets | null {
  if (
    env.IDENTITY_MAIL_ENCRYPTION_KEY === undefined &&
    env.IDENTITY_RESET_TOKEN_KEY === undefined
  ) {
    return null;
  }
  return readStateSecrets(env);
}

export function readStateSecrets(env: StateEnv): StateSecrets {
  return {
    mailEncryptionKeyring: requireKeyring(
      env.IDENTITY_MAIL_ENCRYPTION_KEY,
      "IDENTITY_MAIL_ENCRYPTION_KEY",
      { requireBucketCount: false },
    ),
    resetTokenKeyring: requireKeyring(
      env.IDENTITY_RESET_TOKEN_KEY,
      "IDENTITY_RESET_TOKEN_KEY",
      { requireBucketCount: false },
    ),
  };
}
