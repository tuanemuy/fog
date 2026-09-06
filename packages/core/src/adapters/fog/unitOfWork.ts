import {
  type Client,
  type InValue,
  LibsqlError,
  type Transaction,
} from "@libsql/client";
import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  AuthAttempt,
  AuthRepository,
  FogUnitOfWork,
  FogUnitOfWorkProvider,
  PasswordCredential,
  Session,
  User,
} from "@repo/core/application/fog/ports";
import { CodedError } from "@repo/core/lib/error";
import { z } from "zod";
import { LibsqlAccountRepository } from "./accountRepository";
import { LibsqlAiRepository } from "./aiRepository";
import {
  LibsqlDocumentRepository,
  LibsqlMemoRepository,
  LibsqlTopicRepository,
} from "./contentRepositories";
import { LibsqlDataRepository } from "./dataRepository";

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.string(),
});
const sessionSchema = z.object({
  tokenHash: z.string(),
  userId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
const credentialSchema = z.object({
  userId: z.string(),
  passwordHash: z.string(),
});
const attemptSchema = z.object({
  key: z.string(),
  count: z.number(),
  expiresAt: z.string(),
});
async function one<T>(
  tx: Transaction,
  sql: string,
  args: InValue[],
  schema: z.ZodType<T>,
): Promise<T | null> {
  const result = await tx.execute({ sql, args });
  return result.rows[0] ? schema.parse(result.rows[0]) : null;
}

class LibsqlAuthRepository implements AuthRepository {
  constructor(private readonly tx: Transaction) {}
  findUserByEmail(email: string): Promise<User | null> {
    return one(
      this.tx,
      "SELECT id, email, created_at AS createdAt FROM fog_users WHERE email = ?",
      [email],
      userSchema,
    );
  }
  findUser(id: string): Promise<User | null> {
    return one(
      this.tx,
      "SELECT id, email, created_at AS createdAt FROM fog_users WHERE id = ?",
      [id],
      userSchema,
    );
  }
  async createUser(user: User, passwordHash?: string): Promise<void> {
    await this.tx.execute({
      sql: "INSERT INTO fog_users(id,email,created_at) VALUES(?,?,?)",
      args: [user.id, user.email, user.createdAt],
    });
    if (passwordHash !== undefined)
      await this.tx.execute({
        sql: "INSERT INTO fog_password_credentials(user_id,password_hash) VALUES(?,?)",
        args: [user.id, passwordHash],
      });
  }
  passwordCredential(userId: string): Promise<PasswordCredential | null> {
    return one(
      this.tx,
      "SELECT user_id AS userId,password_hash AS passwordHash FROM fog_password_credentials WHERE user_id = ?",
      [userId],
      credentialSchema,
    );
  }
  async saveSession(session: Session): Promise<void> {
    await this.tx.execute({
      sql: "INSERT INTO fog_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
      args: [
        session.tokenHash,
        session.userId,
        session.createdAt,
        session.expiresAt,
      ],
    });
  }
  findSession(tokenHash: string): Promise<Session | null> {
    return one(
      this.tx,
      "SELECT token_hash AS tokenHash,user_id AS userId,created_at AS createdAt,expires_at AS expiresAt FROM fog_sessions WHERE token_hash = ?",
      [tokenHash],
      sessionSchema,
    );
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.tx.execute({
      sql: "DELETE FROM fog_sessions WHERE token_hash = ?",
      args: [tokenHash],
    });
  }
  getAttempt(key: string): Promise<AuthAttempt | null> {
    return one(
      this.tx,
      "SELECT key,count,expires_at AS expiresAt FROM fog_auth_attempts WHERE key = ?",
      [key],
      attemptSchema,
    );
  }
  async saveAttempt(attempt: AuthAttempt): Promise<void> {
    await this.tx.execute({
      sql: "INSERT INTO fog_auth_attempts(key,count,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at",
      args: [attempt.key, attempt.count, attempt.expiresAt],
    });
  }
  async deleteAttempt(key: string): Promise<void> {
    await this.tx.execute({
      sql: "DELETE FROM fog_auth_attempts WHERE key = ?",
      args: [key],
    });
  }
}

export class LibsqlFogUnitOfWork implements FogUnitOfWorkProvider {
  constructor(private readonly client: Client) {}
  async run<T>(operation: (context: FogUnitOfWork) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let tx: Transaction | undefined;
      try {
        tx = await this.client.transaction("write");
        const transaction = tx;
        const result = await operation({
          auth: new LibsqlAuthRepository(transaction),
          account: new LibsqlAccountRepository(transaction),
          ai: new LibsqlAiRepository(transaction),
          data: (ownerId) => new LibsqlDataRepository(transaction, ownerId),
          retentionOwners: async () =>
            (
              await transaction.execute(
                "SELECT id,retention_days AS retentionDays FROM fog_users ORDER BY id",
              )
            ).rows.map((row) =>
              z
                .object({
                  id: z.string(),
                  retentionDays: z.number().int().positive(),
                })
                .parse(row),
            ),
          memos: (ownerId) => new LibsqlMemoRepository(transaction, ownerId),
          topics: (ownerId) => new LibsqlTopicRepository(transaction, ownerId),
          documents: (ownerId) =>
            new LibsqlDocumentRepository(transaction, ownerId),
        });
        await tx.commit();
        return result;
      } catch (error) {
        if (tx && !tx.closed) await tx.rollback();
        if (error instanceof CodedError) throw error;
        if (
          error instanceof LibsqlError &&
          ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code) &&
          attempt < 3
        ) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, 10 * 2 ** attempt),
          );
          continue;
        }
        if (
          error instanceof LibsqlError &&
          error.code.startsWith("SQLITE_CONSTRAINT")
        )
          throw new ConflictError(
            "STORAGE_CONFLICT",
            "データが更新されました。もう一度お試しください。",
            error,
          );
        throw new SystemError(
          SystemErrorCode.DatabaseError,
          "データを保存できませんでした。もう一度お試しください。",
          error,
        );
      } finally {
        tx?.close();
      }
    }
  }
}
