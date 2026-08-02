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
 * One instance per user. Holds that user's entire domain dataset, including
 * the FTS5 search index, and owns the single Alarm that drives its jobs.
 *
 * Tenant isolation here is structural, not columnar: no table carries a
 * `user_id` predicate that could be forgotten, because no code path can obtain
 * another user's stub.
 *
 * The constructor only retains `ctx` / `env` — no I/O, no randomness, no
 * timers. Everything else happens inside an entry point.
 */
export class UserDataDurableObject extends DurableObject<StateEnv> {
  /**
   * The alarm time currently persisted, cached on the instance so that no
   * entry point has to call `getAlarm()` (whose return value the platform docs
   * describe inconsistently).
   *
   * Owned here and passed *into* the alarm helpers by argument, which is why
   * this class needs no test-only public method to reset it — tests reset it
   * by evicting the instance (`evictAllDurableObjects()`).
   */
  protected readonly alarmCache: AlarmCache = createAlarmCache();

  /**
   * Operator diagnostic. One of exactly two entry points that do **not** run
   * the migration gate, and therefore neither fail closed nor re-arm the
   * alarm: it writes nothing and reads nothing whose shape depends on the
   * schema version, so it cannot damage an un-migrated DO — and it has to keep
   * working precisely when the DO is fail-closed.
   */
  readSchemaVersion(): RpcEnvelope<number> {
    try {
      return ok(readSchemaVersion(this.ctx.storage.sql));
    } catch (error) {
      return err(error);
    }
  }

  /**
   * `ctx.id.name` is populated for stubs obtained through `idFromName`, which
   * is how the request Worker always reaches this class; a stub revived from a
   * raw id has no name, so `_meta.self_locator` is the fallback.
   */
  protected selfLocator(): string {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== "") {
      return name;
    }
    return readSelfLocator(this.ctx.storage.sql) ?? "";
  }
}
