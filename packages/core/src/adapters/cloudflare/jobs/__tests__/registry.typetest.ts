import type {
  IdentityDirectoryJobContext,
  JobHandler,
  JobKindOf,
  UserDataJobContext,
} from "../registry";

// Compile-time only. `pnpm typecheck` is the assertion: if the key constraint
// stops working, the `@ts-expect-error` directives become unused and the
// compiler reports *those*, so the check cannot rot into a no-op.

declare const userDataHandler: JobHandler<UserDataJobContext>;
declare const directoryHandler: JobHandler<IdentityDirectoryJobContext>;

const userDataRegistry: Partial<
  Record<JobKindOf<"userData">, JobHandler<UserDataJobContext>>
> = {
  "purge-trash": userDataHandler,
  // @ts-expect-error `send-mail` is owned by the Identity Directory DO
  "send-mail": userDataHandler,
};

const directoryRegistry: Partial<
  Record<
    JobKindOf<"identityDirectory">,
    JobHandler<IdentityDirectoryJobContext>
  >
> = {
  "send-mail": directoryHandler,
  // @ts-expect-error `purge-trash` is owned by the User Data DO
  "purge-trash": directoryHandler,
};

export type _Assert = [typeof userDataRegistry, typeof directoryRegistry];
