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
};
