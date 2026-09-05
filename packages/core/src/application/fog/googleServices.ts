import { browserBinding, googleReturnTo } from "@repo/core/domain/fog/account";
import { emailAddress } from "@repo/core/domain/fog/content";
import { ConflictError, ForbiddenError, UnauthorizedError } from "../errors";
import type { GoogleRequest } from "./accountPorts";
import type { AccountDependencies } from "./accountSupport";
import type { AccountServices } from "./accountTypes";
import { requireHuman } from "./contentSupport";
import type { FogUnitOfWork } from "./ports";
import { createHumanSession } from "./sessionSupport";
import type { HumanActor } from "./types";

const invalidRequest = () =>
  new UnauthorizedError(
    "INVALID_GOOGLE_AUTH",
    "Google認証の状態が無効または期限切れです。もう一度お試しください。",
  );
const identityExists = () =>
  new ConflictError(
    "GOOGLE_CREDENTIAL_EXISTS",
    "このGoogleアカウントは既に連携されています。",
  );
export function createGoogleServices(
  deps: AccountDependencies,
): Pick<AccountServices, "beginGoogleAuth" | "completeGoogleAuth"> {
  const { unitOfWork, crypto, clock, ids, googleIdentity } = deps;
  const enabled = () => {
    if (!googleIdentity)
      throw new ForbiddenError(
        "GOOGLE_UNAVAILABLE",
        "Google認証は現在利用できません。",
      );
    return googleIdentity;
  };
  const request = async (
    context: FogUnitOfWork,
    actor: HumanActor | null,
    browserToken: string,
    state: string,
  ): Promise<GoogleRequest> => {
    const current = await context.account.findGoogleRequest(
      crypto.digestToken(state),
    );
    if (
      !current ||
      current.consumed ||
      current.expiresAt <= clock.now().toISOString() ||
      current.browserHash !== crypto.digestToken(browserToken) ||
      (current.mode === "link"
        ? actor?.userId !== current.ownerId
        : actor !== null)
    )
      throw invalidRequest();
    return current;
  };
  return {
    async beginGoogleAuth(actor, input) {
      if (actor) requireHuman(actor);
      const provider = enabled();
      const returnTo = googleReturnTo(input.returnTo);
      const browserHash = crypto.digestToken(
        browserBinding(input.browserToken),
      );
      const state = crypto.newToken();
      const nonce = crypto.newToken();
      const verifier = crypto.newToken();
      const common = {
        stateHash: crypto.digestToken(state),
        browserHash,
        nonce,
        verifier,
        returnTo,
        expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
        consumed: false,
      };
      const pending: GoogleRequest = actor
        ? { ...common, mode: "link", ownerId: actor.userId }
        : { ...common, mode: "login", ownerId: null };
      const url = provider.authorizationUrl({
        state,
        nonce,
        codeChallenge: crypto.pkceChallenge(verifier),
      });
      await unitOfWork.run(({ account }) =>
        account.createGoogleRequest(pending),
      );
      return { url };
    },
    async completeGoogleAuth(actor, input) {
      if (actor) requireHuman(actor);
      const provider = enabled();
      const initial = await unitOfWork.run((context) =>
        request(context, actor, input.browserToken, input.state),
      );
      if (input.error) {
        const returnTo = await unitOfWork.run(async (context) => {
          const current = await request(
            context,
            actor,
            input.browserToken,
            input.state,
          );
          await context.account.consumeGoogleRequest(current.stateHash);
          return current.returnTo;
        });
        if (input.error === "access_denied")
          return { kind: "cancelled", returnTo };
        throw new UnauthorizedError(
          "GOOGLE_AUTH_FAILED",
          "Google認証に失敗しました。もう一度お試しください。",
        );
      }
      if (!input.code) throw invalidRequest();
      const identity = await provider.exchange({
        code: input.code,
        codeVerifier: initial.verifier,
        nonce: initial.nonce,
      });
      const email = emailAddress(identity.email);
      return unitOfWork.run(async (context) => {
        const current = await request(
          context,
          actor,
          input.browserToken,
          input.state,
        );
        const credential = await context.account.findGoogleSubject(
          identity.subject,
        );
        if (current.mode === "link") {
          if (credential) throw identityExists();
          await context.account.createGoogleCredential({
            id: ids.next(),
            ownerId: current.ownerId,
            subject: identity.subject,
            email,
            createdAt: clock.now().toISOString(),
          });
          await context.account.consumeGoogleRequest(current.stateHash);
          return { kind: "linked", returnTo: current.returnTo };
        }
        let user = credential
          ? await context.auth.findUser(credential.ownerId)
          : null;
        if (!credential) {
          if (await context.auth.findUserByEmail(email))
            throw new ConflictError(
              "EMAIL_EXISTS",
              "このメールアドレスは登録済みです。パスワードでログインしてGoogle連携を追加してください。",
            );
          user = {
            id: ids.next(),
            email,
            createdAt: clock.now().toISOString(),
          };
          await context.auth.createUser(user);
          await context.account.createGoogleCredential({
            id: ids.next(),
            ownerId: user.id,
            subject: identity.subject,
            email,
            createdAt: clock.now().toISOString(),
          });
        }
        if (!user) throw invalidRequest();
        await context.account.consumeGoogleRequest(current.stateHash);
        return {
          kind: "signedIn",
          auth: await createHumanSession(context, user, deps),
          returnTo: current.returnTo,
        };
      });
    },
  };
}
