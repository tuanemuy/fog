/**
 * Entry of the Durable Object test project (`vitest.config.do.ts`): the same
 * two classes the state Worker exports, so `runInDurableObject` hands back
 * the instances the bindings address.
 */
export { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
export { UserDataDurableObject } from "../userDataDurableObject";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
  // The relay under test publishes for real, and a full batch is delivered
  // to this entry. No suite here is the consumer (the request Worker's
  // consumers are driven directly by their own tests), so the batch is
  // acknowledged rather than left to fail in a handler that does not exist.
  queue(batch: MessageBatch<unknown>): void {
    batch.ackAll();
  },
};
