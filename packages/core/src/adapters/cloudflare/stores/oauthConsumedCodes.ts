/**
 * `oauth_consumed_codes`, adapter-owned (`spec/database/index.md`): the
 * one-time record of an authorization code's `jti`. The insert is the
 * one-time check itself — a primary-key hit is a code already spent — and
 * the same transaction sweeps the rows whose code can no longer verify
 * anyway, so the table never needs a job.
 */
export function consumeCodeJti(
  sql: SqlStorage,
  jti: string,
  expiresAtMs: number,
  nowMs: number,
): boolean {
  sql.exec("DELETE FROM oauth_consumed_codes WHERE expires_at < ?", nowMs);
  const inserted = sql
    .exec<{ jti: string }>(
      "INSERT INTO oauth_consumed_codes (jti, expires_at) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING RETURNING jti",
      jti,
      expiresAtMs,
    )
    .toArray();
  return inserted.length === 1;
}
