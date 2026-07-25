import type { RequestContainer } from "./di/types";

/**
 * The request container as usecases see it: everything but `sessionCodec`.
 *
 * Sessions are a presentation concern (see the port's own JSDoc), and the
 * ban on reaching for them from a usecase is the kind of rule that only
 * holds if the type enforces it — `RequestContainer` keeps the codec for
 * the presentation layer, this type takes it away from everyone inward of
 * it. Passing a `RequestContainer` where this is expected still works, so
 * the presentation layer hands over what `getContainer()` returns.
 */
export type UsecaseContainer = Omit<RequestContainer, "sessionCodec">;

export type ServiceArgs<T> = {
  container: UsecaseContainer;
  input: T;
};
