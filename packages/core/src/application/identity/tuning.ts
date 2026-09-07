import {
  backoffDelayMs,
  DELIVERY_TUNING_DEFAULTS,
  type DeliveryTuning,
} from "../delivery/tuning";
import { SystemError, SystemErrorCode } from "../errors";

/**
 * The operating values identity usecases read through the container — never
 * as literals (`spec/usecases/identity.md`, 共通事項). Three groups: the reset
 * throttle window, the credential reservation TTL, and the login
 * abuse-suppression values that give shape to the three rules of
 * `spec/domains/identity.md` (cap, decay, no counting while throttled).
 */
export type IdentityTuning = Readonly<{
  /** Absolute lifetime of a `reserved` mapping row; checked against the recovery floor. */
  reservationTtlMs: number;
  /** How long after a reservation the coordinator bucket first re-drives the saga. */
  signupResumeDelayMs: number;
  /** Failures (after decay) at which a lockout starts. */
  loginLockoutThreshold: number;
  /** First lockout width; doubles per further failure up to the cap. */
  loginLockoutBaseMs: number;
  /** The cap (rule i). */
  loginLockoutMaxMs: number;
  /** One failure is forgiven per this much time since `nextAttemptAllowedAt` (rule ii). */
  loginAttemptDecayMs: number;
  resetRequestWindowMs: number;
  resetRequestWindowGraceMs: number;
}>;

export const IDENTITY_TUNING_DEFAULTS: IdentityTuning = {
  reservationTtlMs: 3_600_000,
  signupResumeDelayMs: 60_000,
  loginLockoutThreshold: 5,
  loginLockoutBaseMs: 30_000,
  loginLockoutMaxMs: 900_000,
  loginAttemptDecayMs: 900_000,
  resetRequestWindowMs: 900_000,
  resetRequestWindowGraceMs: 300_000,
};

const RESERVATION_TTL_MARGIN_MS = 2_000;

/** Total wall time the job runner spends reaching its attempt ceiling. */
function backoffTotalMs(delivery: DeliveryTuning): number {
  let total = 0;
  for (let attempt = 1; attempt < delivery.jobsMaxAttempts; attempt += 1) {
    total += backoffDelayMs(
      attempt,
      delivery.jobsBackoffBaseMs,
      delivery.jobsBackoffMaxDelayMs,
    );
  }
  return total;
}

/**
 * The floor `spec/recovery/index.md` puts under the reservation TTL: the time
 * to exhaust the forward attempts plus the time to exhaust the cleanup
 * attempts, plus a margin. The cleanup term is never folded into the margin.
 */
export function reservationTtlFloorMs(
  delivery: DeliveryTuning = DELIVERY_TUNING_DEFAULTS,
): number {
  return 2 * backoffTotalMs(delivery) + RESERVATION_TTL_MARGIN_MS;
}

export function createIdentityTuning(
  overrides: Partial<IdentityTuning> = {},
  delivery: DeliveryTuning = DELIVERY_TUNING_DEFAULTS,
): IdentityTuning {
  const tuning: IdentityTuning = { ...IDENTITY_TUNING_DEFAULTS, ...overrides };
  if (tuning.reservationTtlMs <= reservationTtlFloorMs(delivery)) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Identity tuning: reservationTtlMs must exceed the forward + cleanup backoff total plus margin",
    );
  }
  if (tuning.resetRequestWindowMs >= delivery.resetTokenTtlMs) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Identity tuning: resetRequestWindowMs must be strictly less than resetTokenTtlMs",
    );
  }
  if (tuning.loginLockoutThreshold < 1 || tuning.loginLockoutBaseMs <= 0) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Identity tuning: lockout threshold and base width must be positive",
    );
  }
  return Object.freeze(tuning);
}
