import type { GoogleIdentityPort } from "./accountPorts";
import type { ContentDependencies } from "./contentSupport";
import type { SecretCrypto } from "./ports";
export type AccountDependencies = ContentDependencies & {
  crypto: SecretCrypto;
  googleIdentity?: GoogleIdentityPort;
  appUrl?: string;
};
