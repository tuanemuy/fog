import { UserDataSemanticCommit } from "@repo/core/adapters/cloudflare/user-data/semanticCommit";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SemanticCommand,
  SemanticCommitResult,
  SemanticRpcCommand,
} from "@repo/core/application/search/contracts";
import { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";
import { assertLocalSemanticCommand } from "./localSemanticValidation";

/**
 * Local integration capability. This class is never exported by server.state.ts
 * or bound by a production/staging Wrangler configuration.
 */
export class LocalUserDataDurableObject extends UserDataDurableObject {
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
      assertLocalSemanticCommand(command);
      const { version: _version, ...prepared } = command;
      const result = new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
      ).transactionSync(prepared as SemanticCommand);
      await this.ensureAlarm();
      return result;
    });
  }
}
