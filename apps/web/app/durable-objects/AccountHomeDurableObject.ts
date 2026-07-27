import { DurableObject } from "cloudflare:workers";
import type {
  CurrentAccount,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import { AccountHomeStore } from "@repo/core/adapters/cloudflare/account-home/store";
import { migrateAccountHome } from "@repo/core/adapters/cloudflare/account-home/schema";

export class AccountHomeDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateAccountHome(ctx.storage, Date.now());
    });
  }

  beginSignup(input: {
    operationId: string;
    userId: string;
    email: string;
    opaqueKey: string;
    generation: string;
    now: number;
  }): Promise<RpcResult<{ state: string }>> {
    return Promise.resolve(
      new AccountHomeStore(this.ctx.storage).beginSignup(input),
    );
  }

  activateSignup(input: {
    operationId: string;
    opaqueKey: string;
    now: number;
  }): Promise<RpcResult<{ state: string }>> {
    return Promise.resolve(
      new AccountHomeStore(this.ctx.storage).activateSignup(input),
    );
  }

  current(): Promise<RpcResult<CurrentAccount | null>> {
    return Promise.resolve({
      ok: true,
      value: new AccountHomeStore(this.ctx.storage).current(),
    });
  }

  authority(): Promise<RpcResult<{ status: string; epoch: number } | null>> {
    return Promise.resolve({
      ok: true,
      value: new AccountHomeStore(this.ctx.storage).authority(),
    });
  }

  beginDeletion(
    now: number,
  ): Promise<RpcResult<{ epoch: number; locators: readonly string[] }>> {
    return Promise.resolve({
      ok: true,
      value: new AccountHomeStore(this.ctx.storage).beginDeletion(now),
    });
  }

  finishDeletion(
    epoch: number,
    now: number,
  ): Promise<RpcResult<{ completed: boolean }>> {
    return Promise.resolve({
      ok: true,
      value: {
        completed: new AccountHomeStore(this.ctx.storage).finishDeletion(
          epoch,
          now,
        ),
      },
    });
  }

  async restore(): Promise<RpcResult<never>> {
    return {
      ok: false,
      error: {
        kind: "validation",
        code: "ACCOUNT_HOME_RESTORE_FORBIDDEN",
        message: "Account Home is authoritative and cannot be restored",
      },
    };
  }
}
