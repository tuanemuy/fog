import type { InValue, Transaction } from "@libsql/client";
import {
  NotFoundError,
  UnauthorizedError,
} from "@repo/core/application/errors";
import type {
  AccountRepository,
  GoogleCredential,
  GoogleRequest,
  ResetMail,
  ResetToken,
} from "@repo/core/application/fog/accountPorts";
import { z } from "zod";

const credentialSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  subject: z.string(),
  email: z.string(),
  createdAt: z.string(),
});
const requestBase = z.object({
  stateHash: z.string(),
  browserHash: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string(),
  expiresAt: z.string(),
  consumed: z.number().transform((value) => value === 1),
});
const requestSchema = z.discriminatedUnion("mode", [
  requestBase.extend({ mode: z.literal("login"), ownerId: z.null() }),
  requestBase.extend({ mode: z.literal("link"), ownerId: z.string() }),
]);
const resetSchema = z.object({
  tokenHash: z.string(),
  ownerId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
const mailSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  to: z.string(),
  resetUrl: z.string(),
  expiresAt: z.string(),
  attempts: z.number(),
  leaseToken: z.string(),
});
const credentialColumns =
  "id,owner_id ownerId,subject,email,created_at createdAt";
async function one<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T | null> {
  const row = (await tx.execute({ sql, args })).rows[0];
  return row ? schema.parse(row) : null;
}
export class LibsqlAccountRepository implements AccountRepository {
  constructor(private readonly tx: Transaction) {}
  async googleCredentials(ownerId: string) {
    return (
      await this.tx.execute({
        sql: `SELECT ${credentialColumns} FROM fog_google_credentials WHERE owner_id=? ORDER BY created_at,id`,
        args: [ownerId],
      })
    ).rows.map((row) => credentialSchema.parse(row));
  }
  findGoogleSubject(subject: string) {
    return one(
      this.tx,
      `SELECT ${credentialColumns} FROM fog_google_credentials WHERE subject=?`,
      [subject],
      credentialSchema,
    );
  }
  async createGoogleCredential(c: GoogleCredential) {
    await this.tx.execute({
      sql: "INSERT INTO fog_google_credentials(id,owner_id,subject,email,created_at) VALUES(?,?,?,?,?)",
      args: [c.id, c.ownerId, c.subject, c.email, c.createdAt],
    });
  }
  async deleteGoogleCredential(ownerId: string, id: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_google_credentials WHERE owner_id=? AND id=?",
      args: [ownerId, id],
    });
  }
  async createGoogleRequest(r: GoogleRequest) {
    await this.tx.execute({
      sql: "INSERT INTO fog_google_requests(state_hash,browser_hash,nonce,verifier,return_to,expires_at,consumed,mode,owner_id) VALUES(?,?,?,?,?,?,?,?,?)",
      args: [
        r.stateHash,
        r.browserHash,
        r.nonce,
        r.verifier,
        r.returnTo,
        r.expiresAt,
        r.consumed ? 1 : 0,
        r.mode,
        r.ownerId,
      ],
    });
  }
  findGoogleRequest(stateHash: string) {
    return one(
      this.tx,
      "SELECT state_hash stateHash,browser_hash browserHash,nonce,verifier,return_to returnTo,expires_at expiresAt,consumed,mode,owner_id ownerId FROM fog_google_requests WHERE state_hash=?",
      [stateHash],
      requestSchema,
    );
  }
  async consumeGoogleRequest(stateHash: string) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_google_requests SET consumed=1,nonce='',verifier='' WHERE state_hash=? AND consumed=0",
      args: [stateHash],
    });
    if (result.rowsAffected !== 1)
      throw new UnauthorizedError(
        "INVALID_GOOGLE_AUTH",
        "Google認証の状態が無効です。",
      );
  }
  async replacePassword(ownerId: string, passwordHash: string) {
    const result = await this.tx.execute({
      sql: "UPDATE fog_password_credentials SET password_hash=? WHERE user_id=?",
      args: [passwordHash, ownerId],
    });
    if (result.rowsAffected !== 1)
      throw new NotFoundError(
        "PASSWORD_CREDENTIAL_NOT_FOUND",
        "パスワードのログイン手段が見つかりません。",
      );
  }
  async deleteSessions(ownerId: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_sessions WHERE user_id=?",
      args: [ownerId],
    });
  }
  private async invalidatePendingAi(ownerId: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_ai_authorization_requests WHERE owner_id=?",
      args: [ownerId],
    });
    await this.tx.execute({
      sql: "DELETE FROM fog_ai_authorization_codes WHERE owner_id=?",
      args: [ownerId],
    });
  }
  async invalidatePendingAuthorizations(ownerId: string) {
    await this.invalidatePendingAi(ownerId);
    await this.tx.execute({
      sql: "DELETE FROM fog_google_requests WHERE owner_id=?",
      args: [ownerId],
    });
  }
  async createResetToken(t: ResetToken) {
    await this.tx.execute({
      sql: "INSERT INTO fog_password_resets(token_hash,owner_id,created_at,expires_at) VALUES(?,?,?,?)",
      args: [t.tokenHash, t.ownerId, t.createdAt, t.expiresAt],
    });
  }
  findResetToken(tokenHash: string) {
    return one(
      this.tx,
      "SELECT token_hash tokenHash,owner_id ownerId,created_at createdAt,expires_at expiresAt FROM fog_password_resets WHERE token_hash=?",
      [tokenHash],
      resetSchema,
    );
  }
  async deleteResetTokens(ownerId: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_password_resets WHERE owner_id=?",
      args: [ownerId],
    });
  }
  async lastResetAt(ownerId: string) {
    return (
      (
        await one(
          this.tx,
          "SELECT last_reset_at value FROM fog_account_recovery WHERE owner_id=?",
          [ownerId],
          z.object({ value: z.string() }),
        )
      )?.value ?? null
    );
  }
  async saveLastResetAt(ownerId: string, at: string) {
    await this.tx.execute({
      sql: "INSERT INTO fog_account_recovery(owner_id,last_reset_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET last_reset_at=excluded.last_reset_at",
      args: [ownerId, at],
    });
  }
  async revokeAiSince(ownerId: string, since: string, now: string) {
    await this.tx.execute({
      sql: "UPDATE fog_ai_connections SET revoked_at=? WHERE owner_id=? AND created_at>=? AND revoked_at IS NULL",
      args: [now, ownerId, since],
    });
  }
  async revokeAllAi(ownerId: string, now: string) {
    await this.tx.execute({
      sql: "UPDATE fog_ai_connections SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL",
      args: [now, ownerId],
    });
    await this.invalidatePendingAi(ownerId);
  }
  async enqueueResetMail(mail: {
    id: string;
    ownerId: string;
    to: string;
    resetUrl: string;
    expiresAt: string;
    createdAt: string;
  }) {
    await this.tx.execute({
      sql: "INSERT INTO fog_reset_emails(id,owner_id,recipient,reset_url,expires_at,created_at,available_at,attempts) VALUES(?,?,?,?,?,?,?,0)",
      args: [
        mail.id,
        mail.ownerId,
        mail.to,
        mail.resetUrl,
        mail.expiresAt,
        mail.createdAt,
        mail.createdAt,
      ],
    });
  }
  async deleteResetMail(ownerId: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_reset_emails WHERE owner_id=?",
      args: [ownerId],
    });
  }
  claimResetMail(input: {
    now: string;
    leaseUntil: string;
    leaseToken: string;
  }): Promise<ResetMail | null> {
    return one(
      this.tx,
      'UPDATE fog_reset_emails SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM fog_reset_emails WHERE expires_at>? AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at,id LIMIT 1) RETURNING id,owner_id ownerId,recipient AS "to",reset_url resetUrl,expires_at expiresAt,attempts,lease_token leaseToken',
      [input.leaseToken, input.leaseUntil, input.now, input.now, input.now],
      mailSchema,
    );
  }
  async deliveredResetMail(id: string, leaseToken: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_reset_emails WHERE id=? AND lease_token=?",
      args: [id, leaseToken],
    });
  }
  async retryResetMail(input: {
    id: string;
    leaseToken: string;
    availableAt: string;
  }) {
    await this.tx.execute({
      sql: "UPDATE fog_reset_emails SET lease_token=NULL,lease_until=NULL,available_at=? WHERE id=? AND lease_token=?",
      args: [input.availableAt, input.id, input.leaseToken],
    });
  }
  async deleteExpiredResetMail(now: string) {
    await this.tx.execute({
      sql: "DELETE FROM fog_reset_emails WHERE expires_at<=?",
      args: [now],
    });
    await this.tx.execute({
      sql: "DELETE FROM fog_password_resets WHERE expires_at<=?",
      args: [now],
    });
    await this.tx.execute({
      sql: "DELETE FROM fog_google_requests WHERE expires_at<=?",
      args: [now],
    });
  }
}
