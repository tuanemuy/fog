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
import { type Keyring, requireKeyring } from "./secrets";
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

export type StateSecrets = Readonly<{
  mailEncryptionKeyring: Keyring;
  resetTokenKeyring: Keyring;
}>;

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
    uow: createIdentityDirectoryUnitOfWorkProvider(
      ctx,
      shared.clock,
      activeResetTokenGeneration(env),
    ),
  };
}

/**
 * The active reset-token key generation, recorded on every token row so a
 * rotation can tell which key signed which token.
 *
 * Read leniently, and **not** through {@link readStateSecrets}: a Durable
 * Object's constructor runs before any entry point, so throwing here would take
 * out `alarm()` and the operator diagnostics as well, in a deployment whose only
 * fault is an unset optional binding. Generation 1 is the pre-rotation value.
 */
function activeResetTokenGeneration(env: StateEnv): number {
  if (env.IDENTITY_RESET_TOKEN_KEY === undefined) return 1;
  const keyring = requireKeyring(
    env.IDENTITY_RESET_TOKEN_KEY,
    "IDENTITY_RESET_TOKEN_KEY",
    { requireBucketCount: false },
  );
  return keyring.entries[0]?.generation ?? 1;
}

/**
 * The state Worker's secrets, validated strictly. Held in their own object and
 * never merged into a container's public surface, for the same reason the
 * request side nests `RequestSecrets`: a flat placement rides a rest-spread out
 * of the module.
 */
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
