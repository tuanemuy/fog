import { UserDataSemanticCommit } from "@repo/core/adapters/cloudflare/user-data/semanticCommit";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchProjectionPort,
  SemanticCommitResult,
  SemanticRpcCommand,
} from "@repo/core/application/search/contracts";
import { prepareSemanticCommand } from "@repo/core/application/search/prepareSemanticCommand";
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
          repositories.apply(prepared, projection);
        },
      );
      await this.ensureAlarm();
      return result;
    });
  }

  async commitWithProjectionFailure(
    command: SemanticRpcCommand,
  ): Promise<RpcResult<SemanticCommitResult>> {
    return this.rpc(() => {
      const prepared = prepareSemanticCommand(command, Date.now());
      return new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
      ).transactionSync(prepared, (repositories, projection) => {
        const failingProjection: SearchProjectionPort = {
          upsert(entry) {
            projection.upsert(entry);
            throw new Error("TEST_PROJECTION_FAILURE_AFTER_UPSERT");
          },
          remove(entityType, id) {
            projection.remove(entityType, id);
            throw new Error("TEST_PROJECTION_FAILURE_AFTER_REMOVE");
          },
        };
        repositories.apply(prepared, failingProjection);
      });
    });
  }

  async failNextAlarmSchedules(count = 1): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
      throw new TypeError("TEST_ALARM_FAILURE_COUNT_INVALID");
    }
    this.alarmScheduleFailures = count;
  }

  protected override async ensureAlarm(): Promise<void> {
    if (this.alarmScheduleFailures > 0) {
      this.alarmScheduleFailures -= 1;
      throw new Error("TEST_SET_ALARM_FAILURE");
    }
    await super.ensureAlarm();
  }
}
