import { emailAddress, passwordValue } from "@repo/core/domain/fog/content";
import { ConflictError, UnauthorizedError } from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { GoogleIdentityPort } from "./accountPorts";
import { createAccountServices } from "./accountServices";
import { createAiServices } from "./aiServices";
import type { AiClient } from "./aiTypes";
import { createDocumentServices } from "./documentServices";
import { createMemoServices } from "./memoServices";
import type {
  FogUnitOfWork,
  FogUnitOfWorkProvider,
  SecretCrypto,
  User,
} from "./ports";
import { createSearchServices } from "./searchServices";
import { createHumanSession, humanActor } from "./sessionSupport";
import { createTopicServices } from "./topicServices";
import { createTrashServices } from "./trashServices";
import type { FogServices } from "./types";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const unauthorized = () =>
  new UnauthorizedError(
    "INVALID_CREDENTIALS",
    "メールアドレスまたはパスワードが正しくありません。",
  );

export async function createFogServices(deps: {
  unitOfWork: FogUnitOfWorkProvider;
  crypto: SecretCrypto;
  clock: Clock;
  ids: IdGenerator;
  aiClients?: readonly AiClient[];
  googleIdentity?: GoogleIdentityPort;
  appUrl?: string;
}): Promise<FogServices> {
  const { unitOfWork, crypto, clock, ids } = deps;
  const dummyHash = await crypto.hashPassword(crypto.newToken());

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
      const result = await unitOfWork.run(async (context) => {
        const now = clock.now();
        const key = crypto.digestToken(`login:${email}`);
        const attempt = await context.auth.getAttempt(key);
        const active =
          attempt && attempt.expiresAt > now.toISOString() ? attempt : null;
        const user = await context.auth.findUserByEmail(email);
        const credential = user
          ? await context.auth.passwordCredential(user.id)
          : null;
        const verified = await crypto.verifyPassword(
          input.password,
          credential?.passwordHash ?? dummyHash,
        );
        if ((active?.count ?? 0) >= 5 || !user || !credential || !verified) {
          await context.auth.saveAttempt({
            key,
            count: Math.min((active?.count ?? 0) + 1, 6),
            expiresAt:
              active?.expiresAt ??
              new Date(now.getTime() + ATTEMPT_WINDOW_MS).toISOString(),
          });
          return null;
        }
        await context.auth.deleteAttempt(key);
        return session(context, user);
      });
      if (!result) throw unauthorized();
      return result;
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
