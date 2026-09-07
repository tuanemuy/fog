import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import type { UserDataUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import type {
  CredentialLocatorDto,
  CurrentUserDto,
  InitializeAccountDto,
  RecordSignupLocatorDto,
} from "@repo/core/application/identity/gateway";
import { initializeAccountProcedure } from "@repo/core/application/identity/initializeAccount";
import { readCurrentUserProcedure } from "@repo/core/application/identity/readCurrentUser";
import { fromCredentialLocator } from "@repo/core/application/identity/rebuild";
import { recordSignupLocatorProcedure } from "@repo/core/application/identity/recordSignupLocator";
import type {
  PostMemoDto,
  TimelineQueryDto,
} from "@repo/core/application/memo/gateway";
import { getTimelineProcedure } from "@repo/core/application/memo/getTimeline";
import { postMemoProcedure } from "@repo/core/application/memo/postMemo";
import type {
  MemoView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type { AccountState } from "@repo/core/domain/identity/ports/accountStore";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import {
  AsyncWorkDurableObject,
  type StateWorkerEnv,
} from "./durableObjectBase";
import { USER_DATA_PLAN } from "./schema/userDataPlan";
import { createUserDataUnitOfWorkProvider } from "./unitOfWork";

/**
 * One user's data. Every entry takes primitives, rebuilds the value objects
 * inside its unit of work and answers through the envelope. Only
 * `initializeAccount` may bring the object into existence
 * (`runInitializingUnitOfWork`); every other entry fails closed on an
 * uninitialised object.
 */
export class UserDataDurableObject extends AsyncWorkDurableObject<UserDataUnitOfWorkContext> {
  constructor(ctx: DurableObjectState, env: StateWorkerEnv) {
    super(ctx, env, {
      plan: USER_DATA_PLAN,
      allowInitialize: false,
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      jobRegistry: {},
    });
  }

  protected createUnitOfWorkProvider() {
    return createUserDataUnitOfWorkProvider({
      storage: this.ctx.storage,
      clock: this.config.clock,
      idGenerator: this.config.idGenerator,
      selfLocator: this.requireSelfLocator(),
    });
  }

  /** Registration saga phase 2. The schema and the first rows commit together. */
  async initializeAccount(
    input: InitializeAccountDto,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const userId = this.requireSelfLocator();
      const now = this.config.clock.now();
      await this.runInitializingUnitOfWork((ctx) => {
        initializeAccountProcedure(
          ctx,
          {
            userId,
            operationId: input.operationId,
            callerToken: input.callerToken,
            credentials: [input.credential],
            locators: input.locators,
          },
          now,
        );
        return undefined;
      });
    });
  }

  /** Registration saga phase 4. */
  async recordSignupLocator(
    input: RecordSignupLocatorDto,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        recordSignupLocatorProcedure(ctx, input);
        return undefined;
      });
    });
  }

  async readAccountState(): Promise<RpcEnvelope<AccountState | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => ctx.accountStore.find()),
    );
  }

  async findCredentialLocator(
    credentialId: string,
  ): Promise<RpcEnvelope<CredentialLocatorDto | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => {
        const locator = ctx.credentialLocatorStore.findByCredentialId(
          CredentialId.create(credentialId),
        );
        return locator === null ? null : fromCredentialLocator(locator);
      }),
    );
  }

  async readCurrentUser(): Promise<RpcEnvelope<CurrentUserDto | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => readCurrentUserProcedure(ctx)),
    );
  }

  async postMemo(input: PostMemoDto): Promise<RpcEnvelope<MemoView>> {
    return this.envelope(() => {
      const id = this.config.idGenerator.next();
      const now = this.config.clock.now();
      const userId = this.requireSelfLocator();
      return this.runUnitOfWork((ctx) =>
        postMemoProcedure(ctx, { ...input, userId }, id, now),
      );
    });
  }

  async getTimeline(
    query: TimelineQueryDto,
  ): Promise<RpcEnvelope<TimelinePageView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getTimelineProcedure(ctx, query)),
    );
  }
}
