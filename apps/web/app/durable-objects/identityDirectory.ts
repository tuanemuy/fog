import { DurableObject } from "cloudflare:workers";
import {
  type AlarmCache,
  createAlarmCache,
} from "@repo/core/adapters/cloudflare/jobs/alarm";
import { err, ok } from "@repo/core/adapters/cloudflare/platform/envelope";
import {
  readSchemaVersion,
  readSelfLocator,
} from "@repo/core/adapters/cloudflare/schema/gate";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import type { StateEnv } from "./env";

/**
 * One instance per credential bucket (`dir:g{generation}:b{index}`). Holds the
 * credential → `userId` mappings, reset tokens and the bucket's own jobs.
 *
 * The bucket name is derived from an HMAC by the *request* Worker; neither the
 * raw email nor the SSO subject nor the routing secret ever reaches this class
 * (ADR-016).
 */
export class IdentityDirectoryDurableObject extends DurableObject<StateEnv> {
  /** See `UserDataDurableObject.alarmCache` — same ownership rule. */
  protected readonly alarmCache: AlarmCache = createAlarmCache();

  /**
   * Operator diagnostic. Like `readSchemaVersion`, one of exactly two entry
   * points outside the migration gate: gate, fail-closed and alarm re-arming
   * are all skipped.
   *
   * Never logs the ids it returns.
   */
  listBucketUserIds(
    cursor: string | null,
    limit: number,
  ): RpcEnvelope<readonly string[]> {
    try {
      const bounded = Math.max(1, Math.min(limit, 1000));
      const sql = this.ctx.storage.sql;
      const rows =
        cursor === null
          ? sql
              .exec<{ user_id: string }>(
                "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL ORDER BY user_id LIMIT ?",
                bounded,
              )
              .toArray()
          : sql
              .exec<{ user_id: string }>(
                "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?",
                cursor,
                bounded,
              )
              .toArray();
      return ok(rows.map((row) => row.user_id));
    } catch (error) {
      return err(error);
    }
  }

  readSchemaVersion(): RpcEnvelope<number> {
    try {
      return ok(readSchemaVersion(this.ctx.storage.sql));
    } catch (error) {
      return err(error);
    }
  }

  protected selfLocator(): string {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== "") {
      return name;
    }
    return readSelfLocator(this.ctx.storage.sql) ?? "";
  }
}
