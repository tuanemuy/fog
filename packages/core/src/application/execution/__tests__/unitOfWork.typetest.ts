import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "../unitOfWork";

/**
 * The synchronous-callback rule is the whole point of `UnitOfWorkProvider`, and
 * nothing else in the codebase would fail if the conditional return type were
 * dropped. The `@ts-expect-error` directives below are the assertions: relaxing
 * the signature leaves them with nothing to suppress and fails `pnpm typecheck`.
 *
 * A type test, not a runtime suite — there is nothing to execute.
 */

declare const provider: UnitOfWorkProvider<UserDataUnitOfWorkContext>;

// A synchronous callback is what the contract is for.
const sync = (): number => provider.run(() => 1);
void sync;

// @ts-expect-error an `async` callback returns a Promise, which the contract
// collapses to `never`
const asyncCallback = () => provider.run(async () => 1);
void asyncCallback;

// @ts-expect-error the same holds for a callback that returns a Promise
// without being declared `async`
const promiseCallback = () => provider.run(() => Promise.resolve(1));
void promiseCallback;
