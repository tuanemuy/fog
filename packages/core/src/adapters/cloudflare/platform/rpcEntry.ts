import type { DurableObjectState } from "@cloudflare/workers-types";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { type AlarmCache, armAfterRpc } from "../jobs/alarm";
import type { Sql } from "../sql/exec";
import { err, ok } from "./envelope";

export type RpcEntryDeps = Readonly<{
  ctx: DurableObjectState;
  sql: Sql;
  cache: AlarmCache;
  /** The migration gate for this DO class. Synchronous, and never `await`ed. */
  gate: () => void;
}>;

/**
 * The shared shape of every RPC entry: gate, then body, then arm the alarm —
 * and arm it **on the failure path too**.
 *
 * The two operator diagnostics (`read-schema-version` / `list-bucket-user-ids`)
 * are the only entries that do not come through here. They have to keep working
 * on a fail-closed Durable Object, which is exactly what the gate refuses to
 * allow, and they write nothing that could need a wake-up.
 *
 * **Why the failure path arms too.** A transaction can commit and a later
 * statement still throw — the gate's own `enqueue`, or `reserveCredential`'s
 * `sweep-reservations` insert. Arming only on success would leave that job
 * sitting until some unrelated RPC happened to arrive.
 *
 * **Do not conflate this with CPU eviction.** The warning against recovering in
 * a `finally` is about eviction, where the isolate is killed and no `finally`
 * runs at all; nothing can be recovered there. An exception is an ordinary
 * control-flow path and is recoverable.
 */
export async function runRpcEntry<T>(
  deps: RpcEntryDeps,
  now: number,
  body: () => T,
): Promise<RpcEnvelope<T>> {
  let envelope: RpcEnvelope<T>;
  try {
    deps.gate();
    envelope = ok(body());
  } catch (error) {
    envelope = err(error);
  }
  // Issued straight after the body returns, with no `await` in between, so
  // nothing can interleave between a commit and the arming decision.
  try {
    await armAfterRpc(deps.ctx, deps.sql, now, deps.cache);
  } catch (error) {
    // Arming that cannot be persisted is a failure of the call: reporting
    // success would leave a queued job with no wake-up to run it.
    return err(error);
  }
  return envelope;
}
