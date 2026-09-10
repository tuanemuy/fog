import type { DurableObjectBindings } from "@repo/core/adapters/cloudflare/doStubs";
import { createExportGateway } from "@repo/core/adapters/cloudflare/exportGateway";
import { createIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import { createKnowledgeGateway } from "@repo/core/adapters/cloudflare/knowledgeGateway";
import { createMemoGateway } from "@repo/core/adapters/cloudflare/memoGateway";
import { createSearchGateway } from "@repo/core/adapters/cloudflare/searchGateway";
import { createTrashGateway } from "@repo/core/adapters/cloudflare/trashGateway";
import { createConsoleMailSender } from "@repo/core/adapters/mail/consoleMailSender";
import { createResendMailSender } from "@repo/core/adapters/mail/resendMailSender";
import { createDevStubSsoProvider } from "@repo/core/adapters/sso/devStubSsoProvider";
import { createGoogleSsoProvider } from "@repo/core/adapters/sso/googleSsoProvider";
import {
  type AiTokenCodec,
  createAiTokenCodec,
} from "@repo/core/adapters/webcrypto/aiTokenCodec";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import {
  createSsoStateCodec,
  type SsoStateCodec,
} from "@repo/core/adapters/webcrypto/ssoStateCodec";
import { WebCryptoTokenGenerator } from "@repo/core/adapters/webcrypto/webCryptoTokenGenerator";
import { content } from "@repo/core/config";
import type { SsoProvider } from "@repo/core/domain/identity/valueObject";
import { SystemError, SystemErrorCode } from "../errors";
import { createIdentityTuning } from "../identity/tuning";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger, type Logger } from "../ports/logger";
import type { MailSender } from "../ports/mailSender";
import type { SsoIdentityProvider } from "../ports/ssoIdentityProvider";
import {
  type RequestSecrets,
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "./secrets";
import type { AppConfig, RequestContainer } from "./types";

/**
 * What the request Worker's `fetch` receives. Secrets stay optional: nothing
 * validates this type at boot, and `readRequestServerConfig` is where a
 * missing one fails, per request, before any container exists.
 */
export type ServerEnv = Readonly<{
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
  APP_URL?: string;
  DIAGNOSTICS_ENABLED?: string;
  SESSION_SECRET?: string;
  DIRECTORY_ROUTING_SECRET?: string;
  /** The two-generation form of the routing keyring (JSON); wins over the single secret when set. */
  DIRECTORY_ROUTING_KEYRING?: string;
  /** The AI API's token / code / client-id key material (request Worker). */
  AI_CLIENT_TOKEN_SECRET?: string;
  /** Bearer of `/__operator/*` (request Worker); unset means the surface does not exist. */
  OPERATOR_TOKEN?: string;
  /** The mail consumer's provider credential (`.dev.vars.example`). */
  MAIL_PROVIDER_API_KEY?: string;
  /** The sender the provider is asked to use; a `[vars]` entry, not a secret. */
  MAIL_FROM_ADDRESS?: string;
  /** `"console"` selects the development sink; declared in no deployed config. */
  MAIL_DEV_SINK?: string;
  /** `"true"` selects the development identity provider; declared in no deployed config. */
  SSO_DEV_STUB?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}>;

/**
 * Secrets nest under `secrets` so that the rest-spread building `AppConfig`
 * cannot carry them to the client (`secrets.ts`); the bindings nest for the
 * same reason.
 */
export type RequestServerConfig = Readonly<{
  appUrl: string;
  ssoProviders: readonly SsoProvider[];
  secrets: RequestSecrets;
  bindings: DurableObjectBindings;
}>;

/**
 * The providers a screen may offer: exactly those with an adapter behind
 * them. The dev stub serves every name; otherwise Google needs its client,
 * and Apple has no adapter yet, so it is never offered in a deployment.
 */
export function configuredSsoProviders(env: ServerEnv): readonly SsoProvider[] {
  if (env.SSO_DEV_STUB === "true") return ["google", "apple"];
  return hasGoogleClient(env) ? ["google"] : [];
}

function hasGoogleClient(env: ServerEnv): boolean {
  return (
    env.GOOGLE_CLIENT_ID !== undefined &&
    env.GOOGLE_CLIENT_ID.length > 0 &&
    env.GOOGLE_CLIENT_SECRET !== undefined &&
    env.GOOGLE_CLIENT_SECRET.length > 0
  );
}

export function readRequestServerConfig(env: ServerEnv): RequestServerConfig {
  const appUrl = env.APP_URL;
  if (appUrl === undefined || appUrl.length === 0) {
    throw new Error("APP_URL is required on the request path");
  }
  return {
    appUrl: new URL(appUrl).origin,
    ssoProviders: configuredSsoProviders(env),
    secrets: {
      sessionSecret: requireSessionSecret(env.SESSION_SECRET),
      aiClientTokenSecret: requireAiClientTokenSecret(
        env.AI_CLIENT_TOKEN_SECRET,
      ),
      directoryRoutingKeyring: requireDirectoryRoutingKeyring(
        env.DIRECTORY_ROUTING_SECRET,
        env.DIRECTORY_ROUTING_KEYRING,
      ),
    },
    bindings: {
      USER_DATA: env.USER_DATA,
      IDENTITY_DIRECTORY: env.IDENTITY_DIRECTORY,
    },
  };
}

export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const { secrets, bindings, ...rest } = config;
  const appConfig = { ...content, ...rest } satisfies AppConfig;
  const identityTuning = createIdentityTuning();
  return {
    config: appConfig,
    identityGateway: createIdentityGateway({
      bindings,
      keyring: secrets.directoryRoutingKeyring,
      clock: SystemClock,
      tuning: identityTuning,
    }),
    identityTuning,
    memoGateway: createMemoGateway(bindings),
    knowledgeGateway: createKnowledgeGateway(bindings),
    searchGateway: createSearchGateway(bindings),
    trashGateway: createTrashGateway(bindings),
    exportGateway: createExportGateway(bindings),
    passwordHasher: createPbkdf2PasswordHasher(),
    sessionCodec: createHmacSessionCodec({ secret: secrets.sessionSecret }),
    tokenGenerator: WebCryptoTokenGenerator,
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/** What the request Worker's `queue()` handler builds per batch. */
export type QueueContainer = Readonly<{
  mailSender: MailSender;
  logger: Logger;
  bindings: DurableObjectBindings;
}>;

function requireAppUrl(env: ServerEnv, path: string): string {
  const appUrl = env.APP_URL;
  if (appUrl === undefined || appUrl.length === 0) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      `APP_URL is required on the ${path}`,
    );
  }
  return new URL(appUrl).origin;
}

/**
 * The consumer side (`spec/async/index.md`). The sink is chosen once per
 * batch: `MAIL_DEV_SINK="console"` wins locally, otherwise the provider
 * credential selects Resend, and neither is a configuration error — which
 * the consumer turns into a retry, never a silent drop.
 */
export function createQueueContainer(env: ServerEnv): QueueContainer {
  const appUrl = requireAppUrl(env, "queue path");
  const mailSender =
    env.MAIL_DEV_SINK !== undefined
      ? createConsoleMailSender({ appUrl, sink: env.MAIL_DEV_SINK })
      : createProviderMailSender(env, appUrl);
  return {
    mailSender,
    logger: ConsoleLogger,
    bindings: {
      USER_DATA: env.USER_DATA,
      IDENTITY_DIRECTORY: env.IDENTITY_DIRECTORY,
    },
  };
}

function createProviderMailSender(env: ServerEnv, appUrl: string): MailSender {
  const apiKey = env.MAIL_PROVIDER_API_KEY;
  const fromAddress = env.MAIL_FROM_ADDRESS;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "MAIL_PROVIDER_API_KEY is required on the queue path (or MAIL_DEV_SINK locally)",
    );
  }
  if (fromAddress === undefined || fromAddress.length === 0) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "MAIL_FROM_ADDRESS is required on the queue path",
    );
  }
  return createResendMailSender({ apiKey, fromAddress, appUrl });
}

/** What the SSO handlers need beside the request container (design D-07). */
export type SsoRuntime = Readonly<{
  provider: SsoIdentityProvider;
  /** The same list `readRequestServerConfig` puts on `AppConfig.ssoProviders`. */
  providers: readonly SsoProvider[];
  stateCodec: SsoStateCodec;
  /** The development authorize page exists only while this is `true`. */
  devStubEnabled: boolean;
}>;

/**
 * `SSO_DEV_STUB="true"` selects the stub for every provider name; otherwise
 * Google is served when its client is configured, and an unconfigured
 * provider is a configuration error at the moment it is asked for. The
 * state codec's key is derived from `SESSION_SECRET` (PH-06 △-3).
 */
export function createSsoRuntime(
  env: ServerEnv,
  config: RequestServerConfig,
): SsoRuntime {
  const devStubEnabled = env.SSO_DEV_STUB === "true";
  const provider = devStubEnabled
    ? createDevStubSsoProvider(config.appUrl)
    : createConfiguredSsoProvider(env, config.appUrl);
  return {
    provider,
    providers: configuredSsoProviders(env),
    stateCodec: createSsoStateCodec({
      sessionSecret: config.secrets.sessionSecret,
    }),
    devStubEnabled,
  };
}

function createConfiguredSsoProvider(
  env: ServerEnv,
  appUrl: string,
): SsoIdentityProvider {
  const google = hasGoogleClient(env)
    ? createGoogleSsoProvider({
        clientId: env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirectUri: new URL("/auth/sso/google/callback", appUrl).toString(),
      })
    : null;
  const unconfigured = (provider: string): never => {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      `No identity provider is configured for "${provider}"`,
    );
  };
  return {
    buildAuthorizationUrl(provider, state) {
      if (provider === "google" && google !== null) {
        return google.buildAuthorizationUrl(provider, state);
      }
      return unconfigured(provider);
    },
    exchangeCode(provider, code) {
      if (provider === "google" && google !== null) {
        return google.exchangeCode(provider, code);
      }
      return unconfigured(provider);
    },
  };
}

/** What the AI API handlers need beside the request container (PH-07 §1). */
export type AiRuntime = Readonly<{ tokenCodec: AiTokenCodec }>;

export function createAiRuntime(config: RequestServerConfig): AiRuntime {
  return {
    tokenCodec: createAiTokenCodec({
      secret: config.secrets.aiClientTokenSecret,
    }),
  };
}
