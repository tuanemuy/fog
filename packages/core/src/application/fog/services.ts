import { emailAddress, passwordValue } from "@repo/core/domain/fog/content";
import {
  ConflictError,
  SystemError,
  SystemErrorCode,
  UnauthorizedError,
} from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { GoogleIdentityPort } from "./accountPorts";
import { createAccountServices } from "./accountServices";
import { createAiServices } from "./aiServices";
import type { AiClient } from "./aiTypes";
import { createDocumentServices } from "./documentServices";
import { createMemoServices } from "./memoServices";
import type {
  AuthAttempt,
  FogUnitOfWork,
  FogUnitOfWorkProvider,
  PasswordCredential,
  SecretCrypto,
  User,
} from "./ports";
import { createSearchServices } from "./searchServices";
import { createHumanSession, humanActor } from "./sessionSupport";
import { createTopicServices } from "./topicServices";
import { createTrashServices } from "./trashServices";
import type { FogServices } from "./types";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_STATE_RETRIES = 3;
const unauthorized = () =>
  new UnauthorizedError(
    "INVALID_CREDENTIALS",
    "メールアドレスまたはパスワードが正しくありません。",
  );

type LoginState = Readonly<{
  user: User | null;
  credential: PasswordCredential | null;
  attempt: AuthAttempt | null;
}>;

async function readLoginState(
  context: FogUnitOfWork,
  email: string,
  key: string,
): Promise<LoginState> {
  const user = await context.auth.findUserByEmail(email);
  return {
    user,
    credential: user ? await context.auth.passwordCredential(user.id) : null,
    attempt: await context.auth.getAttempt(key),
  };
}

function sameLoginState(left: LoginState, right: LoginState): boolean {
  return (
    left.user?.id === right.user?.id &&
    left.user?.email === right.user?.email &&
    left.user?.createdAt === right.user?.createdAt &&
    left.credential?.userId === right.credential?.userId &&
    left.credential?.passwordHash === right.credential?.passwordHash &&
    left.attempt?.key === right.attempt?.key &&
    left.attempt?.count === right.attempt?.count &&
    left.attempt?.expiresAt === right.attempt?.expiresAt
  );
}

export async function createFogServices(deps: {
  unitOfWork: FogUnitOfWorkProvider;
  crypto: SecretCrypto;
  clock: Clock;
  ids: IdGenerator;
  aiClients?: readonly AiClient[];
  googleIdentity?: GoogleIdentityPort;
  appUrl?: string;
  trashBatchPolicy?: Readonly<{
    rowLimit: number;
    maxTransactions: number;
  }>;
}): Promise<FogServices> {
  const { unitOfWork, crypto, clock, ids } = deps;
  const session = (context: FogUnitOfWork, user: User) =>
    createHumanSession(context, user, deps);

  return {
    async register(input) {
      const email = emailAddress(input.email);
      const password = passwordValue(input.password);
      const passwordHash = await crypto.hashPassword(password);
      return unitOfWork.run(async (context) => {
        if (await context.auth.findUserByEmail(email))
          throw new ConflictError(
            "EMAIL_EXISTS",
            "このメールアドレスは登録済みです。ログインしてください。",
          );
        const user = {
          id: ids.next(),
          email,
          createdAt: clock.now().toISOString(),
        };
        await context.auth.createUser(user, passwordHash);
        return session(context, user);
      });
    },
    async login(input) {
      const email = emailAddress(input.email);
      const key = crypto.digestToken(`login:${email}`);
      for (let retry = 0; retry <= LOGIN_STATE_RETRIES; retry++) {
        const now = clock.now();
        const snapshot = await unitOfWork.read((context) =>
          readLoginState(context, email, key),
        );
        const attempt = snapshot.attempt;
        const active =
          attempt && attempt.expiresAt > now.toISOString() ? attempt : null;
        const verified = await crypto.verifyPassword(
          input.password,
          snapshot.credential?.passwordHash ?? crypto.dummyPasswordHash,
        );
        const rejected =
          (active?.count ?? 0) >= 5 ||
          !snapshot.user ||
          !snapshot.credential ||
          !verified;
        const outcome = await unitOfWork.run(async (context) => {
          const current = await readLoginState(context, email, key);
          if (!sameLoginState(snapshot, current)) return null;
          if (rejected) {
            await context.auth.saveAttempt({
              key,
              count: Math.min((active?.count ?? 0) + 1, 6),
              expiresAt:
                active?.expiresAt ??
                new Date(now.getTime() + ATTEMPT_WINDOW_MS).toISOString(),
            });
            return { kind: "rejected" as const };
          }
          await context.auth.deleteAttempt(key);
          return {
            kind: "authenticated" as const,
            auth: await session(context, snapshot.user),
          };
        });
        if (outcome === null) continue;
        if (outcome.kind === "rejected") throw unauthorized();
        return outcome.auth;
      }
      throw new SystemError(
        SystemErrorCode.CapacityExceeded,
        "Login state changed repeatedly. Try again shortly.",
      );
    },
    async authenticate(token) {
      if (!token || token.length > 256) return null;
      return unitOfWork.run(async ({ auth }) => {
        const tokenHash = crypto.digestToken(token);
        const found = await auth.findSession(tokenHash);
        if (!found) return null;
        if (found.expiresAt <= clock.now().toISOString()) {
          await auth.deleteSession(tokenHash);
          return null;
        }
        const user = await auth.findUser(found.userId);
        return user ? humanActor(user) : null;
      });
    },
    async logout(token) {
      if (!token) return;
      await unitOfWork.run(({ auth }) =>
        auth.deleteSession(crypto.digestToken(token)),
      );
    },
    ...createMemoServices(deps),
    ...createTopicServices(deps),
    ...createDocumentServices(deps),
    ...createTrashServices(deps),
    ...createSearchServices(deps),
    ...createAiServices(deps),
    ...createAccountServices(deps),
  };
}
