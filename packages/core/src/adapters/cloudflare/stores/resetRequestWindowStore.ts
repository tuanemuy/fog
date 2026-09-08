import type { PasswordResetThrottlePort } from "@repo/core/domain/identity/ports/passwordResetThrottlePort";

export type ResetThrottleStoreDeps = Readonly<{
  windowMs: number;
  graceMs: number;
  keyGeneration: number;
}>;

/** The window a request falls in: `${hmac}:${bucket}` — joined, never re-keyed (`spec/database/index.md` 窓キーの導出). */
export function windowKeyOf(
  hmac: string,
  nowMs: number,
  windowMs: number,
): string {
  return `${hmac}:${Math.floor(nowMs / windowMs)}`;
}

/** `reset_request_windows`: one row per canonical and window, written for every request. */
export function createResetThrottleStore(
  sql: SqlStorage,
  deps: ResetThrottleStoreDeps,
): PasswordResetThrottlePort {
  return {
    claimWindow(windowKey, now) {
      const at = now.getTime();
      const inserted = sql
        .exec<{ ok: number }>(
          `INSERT INTO reset_request_windows
             (window_key, key_generation, first_requested_at, last_requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (window_key) DO NOTHING
           RETURNING 1 AS ok`,
          windowKey,
          deps.keyGeneration,
          at,
          at,
          (Math.floor(at / deps.windowMs) + 1) * deps.windowMs + deps.graceMs,
        )
        .toArray().length;
      if (inserted > 0) return true;
      sql.exec(
        "UPDATE reset_request_windows SET last_requested_at = ? WHERE window_key = ?",
        at,
        windowKey,
      );
      return false;
    },
  };
}
