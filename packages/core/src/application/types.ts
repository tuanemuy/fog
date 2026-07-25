import type { RequestContainer } from "./di/types";

/**
 * The request container as usecases see it: everything but `sessionCodec`.
 *
 * The ban on sessions inside usecases (see the port's JSDoc) only holds
 * if the type enforces it. Passing a `RequestContainer` where this is
 * expected still works, so the presentation layer hands over what
 * `getContainer()` returns.
 */
export type UsecaseContainer = Omit<RequestContainer, "sessionCodec">;

export type ServiceArgs<T> = {
  container: UsecaseContainer;
  input: T;
};
