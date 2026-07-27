export { AccountHomeDurableObject } from "./durable-objects/AccountHomeDurableObject";
export { IdentityDirectoryDurableObject } from "./durable-objects/IdentityDirectoryDurableObject";
export { UserDataDurableObject } from "./durable-objects/UserDataDurableObject";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
