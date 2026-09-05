import {
  aiGuidance,
  aiOperations,
  aiReadOperations,
  aiWriteOperations,
  authorizationFields,
  canonicalPayload,
  idempotencyKey,
  validAiRedirectUri,
  validCodeVerifier,
} from "@repo/core/domain/fog/ai";
import type { Actor } from "@repo/core/domain/fog/content";
import { ConflictError, ForbiddenError, UnauthorizedError } from "../errors";
import {
  aiContentServices,
  currentAiResource,
  readAi,
  writeAi,
} from "./aiOperations";
import type { AiAuthorizationRequest } from "./aiPorts";
import type {
  AiClient,
  AiReadRequest,
  AiServices,
  AiWriteRequest,
} from "./aiTypes";
import { type ContentDependencies, requireHuman } from "./contentSupport";
import type { SecretCrypto } from "./ports";

const REQUEST_MS = 10 * 60_000;
const CODE_MS = 2 * 60_000;
const TOKEN_SECONDS = 30 * 24 * 60 * 60;
const invalidRequest = () =>
  new UnauthorizedError(
    "INVALID_AI_AUTHORIZATION",
    "認可リクエストが無効または期限切れです。接続をやり直してください。",
  );
const invalidCode = () =>
  new UnauthorizedError(
    "INVALID_AI_CODE",
    "認可コードを交換できません。接続をやり直してください。",
  );
const invalidConnection = () =>
  new UnauthorizedError(
    "AI_CONNECTION_UNAUTHORIZED",
    "AI接続が無効または失効しています。再接続してください。",
  );
type AiDependencies = ContentDependencies & {
  crypto: SecretCrypto;
  aiClients?: readonly AiClient[];
};
export function createAiServices(deps: AiDependencies): AiServices {
  const { unitOfWork, clock, crypto, ids } = deps;
  const clients = deps.aiClients ?? [];
  const registered = (clientId: string, redirectUri: string) => {
    const client = clients.find((client) => client.id === clientId);
    if (
      !client?.redirectUris.includes(redirectUri) ||
      !validAiRedirectUri(redirectUri)
    )
      throw invalidRequest();
    return client;
  };
  const pending = (
    request: AiAuthorizationRequest | null,
  ): AiAuthorizationRequest => {
    if (
      !request ||
      request.consumed ||
      request.expiresAt <= clock.now().toISOString()
    )
      throw invalidRequest();
    registered(request.clientId, request.redirectUri);
    return request;
  };
  return {
    async beginAiAuthorization(input) {
      registered(input.clientId, input.redirectUri);
      authorizationFields(input);
      const requestToken = crypto.newToken();
      const expiresAt = new Date(
        clock.now().getTime() + REQUEST_MS,
      ).toISOString();
      await unitOfWork.run(({ ai }) =>
        ai.createRequest({
          tokenHash: crypto.digestToken(requestToken),
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          state: input.state,
          codeChallenge: input.codeChallenge,
          expiresAt,
          ownerId: null,
          consumed: false,
        }),
      );
      return { requestToken, expiresAt };
    },
    async getAiAuthorization(actor, requestToken) {
      requireHuman(actor);
      return unitOfWork.run(async ({ ai }) => {
        const request = pending(
          await ai.findRequest(crypto.digestToken(requestToken)),
        );
        if (request.ownerId && request.ownerId !== actor.userId)
          throw invalidRequest();
        await ai.bindRequest(request.tokenHash, actor.userId);
        const client = registered(request.clientId, request.redirectUri);
        return {
          clientId: client.id,
          clientName: client.name,
          redirectUri: request.redirectUri,
          expiresAt: request.expiresAt,
          operations: aiOperations,
          guidance: aiGuidance,
        };
      });
    },
    async decideAiAuthorization(actor, input) {
      requireHuman(actor);
      return unitOfWork.run(async ({ ai }) => {
        const request = pending(
          await ai.findRequest(crypto.digestToken(input.requestToken)),
        );
        if (request.ownerId !== actor.userId) throw invalidRequest();
        const client = registered(request.clientId, request.redirectUri);
        const redirect = new URL(request.redirectUri);
        redirect.searchParams.set("state", request.state);
        await ai.consumeRequest(request.tokenHash);
        if (input.allow) {
          const code = crypto.newToken();
          await ai.createCode({
            codeHash: crypto.digestToken(code),
            clientId: client.id,
            clientName: client.name,
            redirectUri: request.redirectUri,
            codeChallenge: request.codeChallenge,
            ownerId: actor.userId,
            expiresAt: new Date(clock.now().getTime() + CODE_MS).toISOString(),
          });
          redirect.searchParams.set("code", code);
        } else redirect.searchParams.set("error", "access_denied");
        return { redirectUri: redirect.toString() };
      });
    },
    async exchangeAiCode(input) {
      registered(input.clientId, input.redirectUri);
      if (!validCodeVerifier(input.codeVerifier)) throw invalidCode();
      return unitOfWork.run(async ({ ai }) => {
        const code = await ai.findCode(crypto.digestToken(input.code));
        if (
          !code ||
          code.expiresAt <= clock.now().toISOString() ||
          code.clientId !== input.clientId ||
          code.redirectUri !== input.redirectUri ||
          crypto.pkceChallenge(input.codeVerifier) !== code.codeChallenge
        )
          throw invalidCode();
        const accessToken = crypto.newToken();
        const now = clock.now();
        await ai.deleteCode(code.codeHash);
        await ai.createConnection({
          id: ids.next(),
          ownerId: code.ownerId,
          clientId: code.clientId,
          clientName: code.clientName,
          createdAt: now.toISOString(),
          lastUsedAt: null,
          expiresAt: new Date(
            now.getTime() + TOKEN_SECONDS * 1000,
          ).toISOString(),
          tokenHash: crypto.digestToken(accessToken),
          revokedAt: null,
        });
        return { accessToken, tokenType: "Bearer", expiresIn: TOKEN_SECONDS };
      });
    },
    async listAiConnections(actor) {
      requireHuman(actor);
      return unitOfWork.run(({ ai }) =>
        ai.listConnections(actor.userId, clock.now().toISOString()),
      );
    },
    async revokeAiConnection(actor, input) {
      requireHuman(actor);
      await unitOfWork.run(({ ai }) =>
        ai.revokeConnection(actor.userId, input.id, clock.now().toISOString()),
      );
    },
    async executeAi(accessToken, request) {
      return unitOfWork.run(async (context) => {
        const connection = await context.ai.findConnection(
          crypto.digestToken(accessToken),
        );
        const now = clock.now().toISOString();
        if (
          !connection ||
          connection.revokedAt ||
          connection.expiresAt <= now ||
          !clients.some((client) => client.id === connection.clientId)
        )
          throw invalidConnection();
        const actor: Actor = {
          kind: "ai",
          userId: connection.ownerId,
          clientId: connection.clientId,
          clientName: connection.clientName,
        };
        const services = aiContentServices(context, deps);
        const operation: string = request.operation;
        if (!(aiOperations as readonly string[]).includes(operation))
          throw new ForbiddenError(
            "AI_OPERATION_FORBIDDEN",
            "この操作はAIに許可されていません。",
          );
        await context.ai.touchConnection(connection.id, now);
        if ((aiReadOperations as readonly string[]).includes(operation))
          return readAi(services, actor, request as AiReadRequest);
        if (!(aiWriteOperations as readonly string[]).includes(operation))
          throw new ForbiddenError(
            "AI_OPERATION_FORBIDDEN",
            "この操作はAIに許可されていません。",
          );
        const write = request as AiWriteRequest;
        const keyHash = crypto.digestToken(
          idempotencyKey(write.idempotencyKey),
        );
        const payloadHash = crypto.digestToken(
          canonicalPayload({ operation: write.operation, input: write.input }),
        );
        const previous = await context.ai.findLedger(connection.id, keyHash);
        if (previous) {
          if (previous.payloadHash !== payloadHash)
            throw new ConflictError(
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "同じ冪等性キーで異なる要求を送信できません。",
            );
          return {
            kind: "receipt",
            operation: previous.operation,
            requestId: previous.requestId,
            replayed: true,
            resource: await currentAiResource(
              context,
              actor.userId,
              previous.resource,
            ),
          };
        }
        const resource = await writeAi(services, actor, write);
        const requestId = ids.next();
        await context.ai.saveLedger({
          connectionId: connection.id,
          keyHash,
          payloadHash,
          operation: write.operation,
          requestId,
          resource,
          createdAt: now,
        });
        return {
          kind: "receipt",
          operation: write.operation,
          requestId,
          replayed: false,
          resource: await currentAiResource(context, actor.userId, resource),
        };
      });
    },
  };
}
