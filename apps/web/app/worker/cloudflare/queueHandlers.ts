import {
  callDurableObject,
  directoryStub,
} from "@repo/core/adapters/cloudflare/doStubs";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import type { OutboxQueueMessage } from "@repo/core/adapters/cloudflare/queueMessage";
import {
  createQueueContainer,
  type QueueContainer,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import type { Logger } from "@repo/core/application/ports/logger";
import { PASSWORD_RESET_REQUESTED } from "@repo/core/domain/identity/passwordResetRequested";

/**
 * The DLQ is picked by this suffix. Nothing here can check the queue
 * name it is matched against; `wranglerConfig.test.ts` holds the config
 * to it.
 */
export const DLQ_QUEUE_SUFFIX = "-dlq";

const DIRECTORY_ROUTING_KEY = /^dir:g(\d+):b(\d+)$/;

/**
 * The request Worker's `queue()` body: the mail consumer for the events
 * queue and the DLQ handler for its dead-letter queue. Both hold the
 * consumer-side catch boundary — a failure becomes a queue retry (and
 * eventually the DLQ), never an unhandled rejection — and both log at
 * most `eventId`, `type` and an outcome (`spec/async/index.md`).
 */
export async function runQueueBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  env: ServerEnv,
): Promise<void> {
  const isDlq = batch.queue.endsWith(DLQ_QUEUE_SUFFIX);
  let container: QueueContainer;
  try {
    container = createQueueContainer(env);
  } catch (error) {
    const logger = createDlqLogger(env);
    logger.error("Mail consumer is not configured", {
      cause: error instanceof Error ? error.message : "unknown",
    });
    if (isDlq) {
      // No sink to re-drive through: the DLQ still ends here, acked.
      for (const message of batch.messages) {
        logger.warn("dlq", {
          eventId: message.body.eventId,
          type: message.body.type,
          outcome: "failed",
        });
      }
      batch.ackAll();
      return;
    }
    // No sink at all: every message comes back later rather than being
    // dropped, and the reason is a configuration one, logged once.
    batch.retryAll();
    return;
  }
  if (isDlq) {
    await handleDlqBatch(batch, container);
    return;
  }
  await handleEventsBatch(batch, container);
}

function createDlqLogger(env: ServerEnv): Logger {
  void env;
  return {
    info: (message, meta) => console.info(message, meta ?? {}),
    warn: (message, meta) => console.warn(message, meta ?? {}),
    error: (message, meta) => console.error(message, meta ?? {}),
  };
}

export type DeliveryOutcome = "sent" | "nothing-to-send" | "unserved";

/**
 * One delivery attempt: the routing key names the bucket, the bucket
 * answers the send-materials RPC under its three-condition guard, and
 * `nothing-to-send` is a completed delivery with no mail (the token was
 * spent, expired, or the guard refused). A message whose type or routing
 * key this consumer does not serve is `unserved`. Anything else throws.
 */
export async function deliverOnce(
  body: OutboxQueueMessage,
  container: QueueContainer,
): Promise<DeliveryOutcome> {
  const { eventId, type, routingKey, ownerToken } = body;
  if (type !== PASSWORD_RESET_REQUESTED) return "unserved";
  const match = DIRECTORY_ROUTING_KEY.exec(routingKey);
  if (match === null) return "unserved";
  const stub = directoryStub(container.bindings.IDENTITY_DIRECTORY, {
    generation: Number(match[1]),
    bucketIndex: Number(match[2]),
  }) as unknown as IdentityDirectoryDurableObject;
  const materials = await callDurableObject(() =>
    stub.getResetMailMaterials({ eventId, ownerToken }),
  );
  if (materials.kind !== "send") return "nothing-to-send";
  await container.mailSender.sendPasswordResetMail(
    materials.to,
    materials.resetToken,
    materials.providerIdempotencyKey,
  );
  return "sent";
}

/**
 * One message at a time. An unserved message is retried so it ends in
 * the DLQ with its `type` visible, rather than acked into silence.
 */
export async function handleEventsBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  container: QueueContainer,
): Promise<void> {
  for (const message of batch.messages) {
    const { eventId, type } = message.body;
    try {
      const outcome = await deliverOnce(message.body, container);
      if (outcome === "unserved") {
        container.logger.warn("Unserved event", { eventId, type });
        message.retry();
        continue;
      }
      message.ack();
    } catch (error) {
      container.logger.error("Mail delivery failed", {
        eventId,
        type,
        cause: error instanceof Error ? error.name : "unknown",
      });
      message.retry();
    }
  }
}

/**
 * The DLQ handler re-drives each message **once** through the same
 * delivery as the consumer, then acks whatever happened (design D-16
 * △-8): a message the DLQ holds is the only copy, and there is no pull
 * API to hand it back later. A `(event.id, owner_token)` pair the
 * operator has since re-minted answers `nothing-to-send`, so a re-drive
 * of an old message never sends twice. The log carries `eventId`, `type`
 * and the outcome and nothing else; the message is never forwarded and
 * never logged as a whole.
 */
export async function handleDlqBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  container: QueueContainer,
): Promise<void> {
  for (const message of batch.messages) {
    const { eventId, type } = message.body;
    let outcome: DeliveryOutcome | "failed";
    try {
      outcome = await deliverOnce(message.body, container);
    } catch {
      outcome = "failed";
    }
    container.logger.warn("dlq", { eventId, type, outcome });
    try {
      message.ack();
    } catch {
      // The batch-level ack below covers a message whose ack threw.
    }
  }
  batch.ackAll();
}
