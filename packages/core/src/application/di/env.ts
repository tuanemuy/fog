import { z } from "zod";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from "../workers/eventRelayWorker";
import { DEFAULT_OUTBOX_RETENTION_MS } from "../workers/outboxPrune";

/**
 * Worker-tuning env variables.
 *
 * They ride on the `ServerEnv` shape every Worker declares (it is
 * structurally compatible with this type), but only two Workers actually
 * read them: the relay through `readRelayTuning` and the pruner through
 * `readPruneTuning` (`apps/web/app/worker/cloudflare/handlers.ts`).
 * Accordingly the values are declared only under `[env.relay.vars]`
 * (`OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_MAX_ATTEMPTS`) and
 * `[env.pruner.vars]` (`OUTBOX_RETENTION_MS`) in `apps/web/wrangler.toml`
 * — the top-level, consumer and DLQ Workers declare none of them.
 */
export type TuningEnv = Readonly<{
  OUTBOX_BATCH_SIZE?: string | undefined;
  OUTBOX_LEASE_MS?: string | undefined;
  OUTBOX_MAX_ATTEMPTS?: string | undefined;
  OUTBOX_RETENTION_MS?: string | undefined;
}>;

const relayTuningSchema = z.object({
  batchSize: z.coerce.number().int().positive().default(DEFAULT_BATCH_SIZE),
  leaseMs: z.coerce.number().int().positive().default(DEFAULT_LEASE_MS),
  maxAttempts: z.coerce.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
});

const pruneTuningSchema = z.object({
  retentionMs: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_RETENTION_MS),
});

export type RelayTuning = z.infer<typeof relayTuningSchema>;
export type PruneTuning = z.infer<typeof pruneTuningSchema>;

export function readRelayTuning(env: TuningEnv): RelayTuning {
  return relayTuningSchema.parse({
    batchSize: env.OUTBOX_BATCH_SIZE,
    leaseMs: env.OUTBOX_LEASE_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });
}

export function readPruneTuning(env: TuningEnv): PruneTuning {
  return pruneTuningSchema.parse({
    retentionMs: env.OUTBOX_RETENTION_MS,
  });
}
