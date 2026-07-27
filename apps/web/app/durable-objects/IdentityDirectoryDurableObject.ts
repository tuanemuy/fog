import { DurableObject } from "cloudflare:workers";
import type {
  PasswordCredential,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import {
  IdentityDirectoryStore,
  type ReserveCredential,
} from "@repo/core/adapters/cloudflare/identity-directory/store";
import { migrateIdentityDirectory } from "@repo/core/adapters/cloudflare/identity-directory/schema";

export class IdentityDirectoryDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateIdentityDirectory(ctx.storage, Date.now());
    });
  }

  reserve(input: ReserveCredential): Promise<RpcResult<{ userId: string }>> {
    return Promise.resolve(
      new IdentityDirectoryStore(this.ctx.storage).reserve(input),
    );
  }

  activate(input: {
    opaqueKey: string;
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string }>> {
    return Promise.resolve(
      new IdentityDirectoryStore(this.ctx.storage).activate(input),
    );
  }

  lookupPassword(
    opaqueKey: string,
  ): Promise<RpcResult<PasswordCredential | null>> {
    return Promise.resolve({
      ok: true,
      value: new IdentityDirectoryStore(this.ctx.storage).lookupPassword(
        opaqueKey,
      ),
    });
  }

  lookup(
    opaqueKey: string,
  ): Promise<RpcResult<{ userId: string; kind: string } | null>> {
    const row = new IdentityDirectoryStore(this.ctx.storage).lookup(opaqueKey);
    return Promise.resolve({
      ok: true,
      value: row ? { userId: row.user_id, kind: row.kind } : null,
    });
  }

  reclaimExpired(now: number): Promise<RpcResult<{ reclaimed: number }>> {
    return Promise.resolve({
      ok: true,
      value: {
        reclaimed: new IdentityDirectoryStore(this.ctx.storage).reclaimExpired(
          now,
        ),
      },
    });
  }

  async storePasswordReset(input: {
    tokenHash: string;
    userId: string;
    operationId: string;
    expiresAt: number;
  }): Promise<RpcResult<null>> {
    new IdentityDirectoryStore(this.ctx.storage).storePasswordReset(input);
    return { ok: true, value: null };
  }

  async consumePasswordReset(
    tokenHash: string,
    now: number,
  ): Promise<RpcResult<{ userId: string } | null>> {
    return {
      ok: true,
      value: new IdentityDirectoryStore(this.ctx.storage).consumePasswordReset(
        tokenHash,
        now,
      ),
    };
  }
}
