import type { Clock } from "../ports/clock";
import type { FogUnitOfWork, SecretCrypto, User } from "./ports";
import type { AuthResult, HumanActor } from "./types";

export const humanActor = (user: User): HumanActor => ({
  kind: "human",
  userId: user.id,
  email: user.email,
});
export async function createHumanSession(
  context: FogUnitOfWork,
  user: User,
  { clock, crypto }: { clock: Clock; crypto: SecretCrypto },
): Promise<AuthResult> {
  const token = crypto.newToken();
  const now = clock.now();
  await context.auth.saveSession({
    tokenHash: crypto.digestToken(token),
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  });
  return { token, user: humanActor(user) };
}
