import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type {
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import type { IdentityGateway } from "../identity/gateway";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger, LogMeta } from "../ports/logger";
import type { TokenGenerator } from "../ports/tokenGenerator";

export { trippingKnowledgeGateway } from "./fakes/fakeKnowledgeGateway";
export { trippingMemoGateway } from "./fakes/fakeMemoGateway";
export { trippingSearchGateway } from "./fakes/fakeSearchGateway";
export { trippingTrashGateway } from "./fakes/fakeTrashGateway";

/**
 * Deterministic ids that still pass `IdGenerator.validate`. The `ffffffff`
 * prefix sorts generated ids after any fixed `01950000-…` fixture when a
 * suite orders by `(createdAt, id)`.
 */
export class FakeIdGenerator implements IdGenerator {
  private counter: number;

  constructor(start = 1) {
    this.counter = start;
  }

  next(): string {
    const n = (this.counter++).toString(16).padStart(12, "0");
    return `ffffffff-ffff-7fff-8fff-${n}`;
  }

  validate(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    );
  }
}

/** Deterministic 32-hex tokens: `f...0001`, `f...0002`, …, distinct per call. */
export class FakeTokenGenerator implements TokenGenerator {
  private counter: number;

  constructor(start = 1) {
    this.counter = start;
  }

  next(): string {
    return (this.counter++).toString(16).padStart(32, "f");
  }
}

export type LogEntry = Readonly<{
  level: "info" | "warn" | "error";
  message: string;
  meta: LogMeta | undefined;
}>;

export class FakeLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string, meta?: LogMeta): void {
    this.entries.push({ level: "info", message, meta });
  }

  warn(message: string, meta?: LogMeta): void {
    this.entries.push({ level: "warn", message, meta });
  }

  error(message: string, meta?: LogMeta): void {
    this.entries.push({ level: "error", message, meta });
  }

  byLevel(level: LogEntry["level"]): readonly LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}

/** Cheap deterministic digest that never embeds the plaintext. */
export class FakePasswordHasher implements PasswordHasher {
  hashCalls = 0;
  verifyCalls = 0;

  async hash(plain: PlainPassword): Promise<PasswordHash> {
    this.hashCalls += 1;
    return `fake$${digest(plain)}` as PasswordHash;
  }

  async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
    this.verifyCalls += 1;
    return hash === `fake$${digest(plain)}`;
  }
}

function digest(value: string): string {
  let h = 2166136261;
  for (const char of value) {
    h ^= char.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const IDENTITY_GATEWAY_METHODS = [
  "readAccountState",
  "deriveCredentialLocator",
  "reserveCredential",
  "initializeAccount",
  "commitSignupSaga",
  "activateReservation",
  "recordSignupLocator",
  "resolveLoginCredential",
  "recordAttemptOutcome",
  "findCredentialLocator",
  "readCurrentUser",
  "changeTrashRetentionDays",
  "revealCanonical",
  "requestPasswordReset",
  "consumeResetToken",
  "cancelReservation",
  "beginCredentialChange",
  "applyCredentialChange",
  "markCredentialChangeAdvanced",
  "promoteVerifier",
  "readCredentialForChange",
  "resolveSsoIdentity",
  "beginLink",
  "completeLink",
  "finishLink",
  "beginUnlink",
  "deleteMapping",
  "finishUnlink",
  "revokeAllAiClientConnections",
  "approveAiClientAuthorization",
  "listAiClientConnections",
  "revokeAiClientConnection",
  "authorizeAiClient",
  "consumeAuthorizationCode",
] as const satisfies readonly (keyof IdentityGateway)[];

type Exhaustive<T extends readonly (keyof IdentityGateway)[]> =
  Exclude<keyof IdentityGateway, T[number]> extends never ? T : never;
const _identityGatewayRoster: Exhaustive<typeof IDENTITY_GATEWAY_METHODS> =
  IDENTITY_GATEWAY_METHODS;
void _identityGatewayRoster;

/**
 * An `IdentityGateway` whose every entry throws through `trip`, except the
 * ones a suite overrides. Total — a method added to the port is a type error
 * here — so a test cannot silently reach an entry nobody meant it to.
 */
export function trippingIdentityGateway(
  trip: (name: keyof IdentityGateway) => never,
  overrides: Partial<IdentityGateway> = {},
): IdentityGateway {
  const gateway = {} as Record<keyof IdentityGateway, unknown>;
  for (const name of IDENTITY_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as IdentityGateway;
}
