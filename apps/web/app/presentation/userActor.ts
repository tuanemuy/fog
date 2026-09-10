/**
 * The human actor of a request, rebuilt from the session's user id. The
 * value-object module is imported lazily so it stays out of the client
 * bundle of the islands that import an actions module.
 */
export async function userActorOf(userId: string) {
  const { Actor, UserId } = await import(
    "@repo/core/domain/identity/valueObject"
  );
  return Actor.user(UserId.create(userId));
}
