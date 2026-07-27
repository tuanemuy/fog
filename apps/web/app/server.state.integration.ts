export { AccountHomeDurableObject } from "./durable-objects/AccountHomeDurableObject";
export { IdentityDirectoryDurableObject } from "./durable-objects/IdentityDirectoryDurableObject";
export { LocalUserDataDurableObject as UserDataDurableObject } from "./testing/LocalUserDataDurableObject";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
