import { UserDataSemanticCommit } from "@repo/core/adapters/cloudflare/user-data/semanticCommit";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SemanticCommitResult,
  SemanticRpcCommand,
  SemanticTransactionCallback,
} from "@repo/core/application/search/contracts";
import { applySemanticCommand } from "@repo/core/application/search/applySemanticCommand";
import { prepareSemanticCommand } from "@repo/core/application/search/prepareSemanticCommand";
import type { SearchProjectionFaultPoint } from "@repo/core/adapters/cloudflare/user-data/searchIndex";
import { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";

/**
 * Local integration capability. This class is never exported by server.state.ts
 * or bound by a production/staging Wrangler configuration.
 */
export class LocalUserDataDurableObject extends UserDataDurableObject {
  private alarmScheduleFailures = 0;

  async initialize(input: {
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string; trashRetentionDays: number }>> {
    return this.identityInitializeV1({
      version: 1,
      operationId: input.operationId,
      payload: { userId: input.userId, now: input.now },
    });
  }

  async getProfile(): Promise<
    RpcResult<{ userId: string; trashRetentionDays: number }>
  > {
    return this.identityGetProfileV1({
      version: 1,
      payload: { userId: this.profile().userId },
    });
  }

  async commit(
    command: SemanticRpcCommand,
  ): Promise<RpcResult<SemanticCommitResult>> {
    return this.rpc(async () => {
      const prepared = prepareSemanticCommand(command, Date.now());
      const semanticCommit = new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
      );
      const result = semanticCommit.transactionSync(
        prepared,
        (repositories, projection) => {
          return applySemanticCommand(prepared, repositories, projection);
        },
      );
      await this.ensureAlarm();
      return result;
    });
  }

  async commitWithProjectionFailure(
    command: SemanticRpcCommand,
    point: SearchProjectionFaultPoint = "after-entry-insert",
  ): Promise<RpcResult<SemanticCommitResult>> {
    return this.rpc(() => {
      const prepared = prepareSemanticCommand(command, Date.now());
      return new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
        (candidate) => {
          if (candidate === point) {
            throw new Error(`TEST_PROJECTION_FAILURE_${point}`);
          }
        },
      ).transactionSync(prepared, (repositories, projection) => {
        return applySemanticCommand(prepared, repositories, projection);
      });
    });
  }

  async commitWithAsyncCallback(
    command: SemanticRpcCommand,
  ): Promise<RpcResult<SemanticCommitResult>> {
    return this.rpc(() => {
      const prepared = prepareSemanticCommand(command, Date.now());
      const callback = (async (
        repositories: Parameters<SemanticTransactionCallback>[0],
        projection: Parameters<SemanticTransactionCallback>[1],
      ) => {
        applySemanticCommand(prepared, repositories, projection);
        await Promise.resolve();
        return undefined;
      }) as unknown as SemanticTransactionCallback;
      return new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
      ).transactionSync(prepared, callback);
    });
  }

  async failNextAlarmSchedules(count = 1): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
      throw new TypeError("TEST_ALARM_FAILURE_COUNT_INVALID");
    }
    this.alarmScheduleFailures = count;
  }

  protected override async ensureAlarm(reschedule = false): Promise<void> {
    if (this.alarmScheduleFailures > 0) {
      this.alarmScheduleFailures -= 1;
      throw new Error("TEST_SET_ALARM_FAILURE");
    }
    await super.ensureAlarm(reschedule);
  }
}
