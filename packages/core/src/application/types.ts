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

/**
 * A usecase's arguments. `C` is what the usecase reads off the container;
 * a usecase reached from more than one face (the AI tools among them)
 * declares the narrowest `Needs<…>` it can, so a caller holding only that
 * much can call it and nothing wider leaks through the call.
 */
export type ServiceArgs<T, C = UsecaseContainer> = {
  container: C;
  input: T;
};

/** The container members a usecase needs, and no others. */
export type Needs<K extends keyof UsecaseContainer> = Pick<UsecaseContainer, K>;
