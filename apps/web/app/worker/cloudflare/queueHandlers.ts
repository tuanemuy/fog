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
 * most `eventId` and `type` (`spec/async/index.md`).
 */
export async function runQueueBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  env: ServerEnv,
): Promise<void> {
  if (batch.queue.endsWith(DLQ_QUEUE_SUFFIX)) {
    handleDlqBatch(batch, createDlqLogger(env));
    return;
  }
  let container: QueueContainer;
  try {
    container = createQueueContainer(env);
  } catch (error) {
    // No sink at all: every message comes back later rather than being
    // dropped, and the reason is a configuration one, logged once.
    createDlqLogger(env).error("Mail consumer is not configured", {
      cause: error instanceof Error ? error.message : "unknown",
    });
    batch.retryAll();
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

/**
 * One message at a time: the routing key names the bucket, the bucket
 * answers the send-materials RPC under its three-condition guard, and
 * `nothing-to-send` is an ack (the token was spent, expired, or the guard
 * refused — in every case there is no mail to send). A message whose type
 * or routing key this consumer does not serve is retried so it ends in the
 * DLQ with its `type` visible, rather than acked into silence.
 */
export async function handleEventsBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  container: QueueContainer,
): Promise<void> {
  for (const message of batch.messages) {
    const { eventId, type, routingKey, ownerToken } = message.body;
    try {
      if (type !== PASSWORD_RESET_REQUESTED) {
        container.logger.warn("Unserved event type", { eventId, type });
        message.retry();
        continue;
      }
      const match = DIRECTORY_ROUTING_KEY.exec(routingKey);
      if (match === null) {
        container.logger.warn("Unserved routing key", { eventId, type });
        message.retry();
        continue;
      }
      const stub = directoryStub(container.bindings.IDENTITY_DIRECTORY, {
        generation: Number(match[1]),
        bucketIndex: Number(match[2]),
      }) as unknown as IdentityDirectoryDurableObject;
      const materials = await callDurableObject(() =>
        stub.getResetMailMaterials({ eventId, ownerToken }),
      );
      if (materials.kind === "send") {
        await container.mailSender.sendPasswordResetMail(
          materials.to,
          materials.resetToken,
          materials.providerIdempotencyKey,
        );
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
 * The DLQ handler acks everything after a warning of `eventId` and
 * `type`. The message is never forwarded anywhere and never logged as a
 * whole; the event row it came from is what an operator inspects.
 */
export function handleDlqBatch(
  batch: MessageBatch<OutboxQueueMessage>,
  logger: Logger,
): void {
  try {
    for (const message of batch.messages) {
      logger.warn("dlq", {
        eventId: message.body.eventId,
        type: message.body.type,
      });
      message.ack();
    }
  } catch {
    batch.ackAll();
  }
}
