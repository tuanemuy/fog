import { describe, expect, it } from "vitest";
import { DELIVERY_TUNING_DEFAULTS } from "../../delivery/tuning";
import { isSystemError, SystemErrorCode } from "../../errors";
import {
  createIdentityTuning,
  IDENTITY_TUNING_DEFAULTS,
  reservationTtlFloorMs,
} from "../tuning";

function configurationErrorFrom(fn: () => unknown): boolean {
  try {
    fn();
  } catch (error) {
    return (
      isSystemError(error) && error.code === SystemErrorCode.ConfigurationError
    );
  }
  return false;
}

describe("reservationTtlFloorMs", () => {
  // Defaults: attempts 1..4 of a 5-attempt runner back off 2 s, 4 s, 8 s, 16 s
  // (30 s). Forward = the 60 s first re-drive wait + 30 s; cleanup = the
  // runner's attempt-0 wait (1 s) + 30 s; plus the 2 s margin.
  it("is 123,000 ms with the default tuning", () => {
    expect(reservationTtlFloorMs()).toBe(123_000);
    expect(reservationTtlFloorMs(DELIVERY_TUNING_DEFAULTS)).toBe(123_000);
    expect(
      reservationTtlFloorMs(
        DELIVERY_TUNING_DEFAULTS,
        IDENTITY_TUNING_DEFAULTS.signupResumeDelayMs,
      ),
    ).toBe(123_000);
  });

  it("moves with the job runner's backoff and the first re-drive wait", () => {
    expect(
      reservationTtlFloorMs(
        { ...DELIVERY_TUNING_DEFAULTS, jobsMaxAttempts: 2 },
        10_000,
      ),
    ).toBe(10_000 + 2_000 + 1_000 + 2_000 + 2_000);
  });

  it("checks the TTL against the floor of the tuning's own re-drive wait", () => {
    const floor = reservationTtlFloorMs(DELIVERY_TUNING_DEFAULTS, 100_000);
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({
          signupResumeDelayMs: 100_000,
          reservationTtlMs: floor,
        }),
      ),
    ).toBe(true);
    expect(
      createIdentityTuning({
        signupResumeDelayMs: 100_000,
        reservationTtlMs: floor + 1,
      }).reservationTtlMs,
    ).toBe(floor + 1);
  });
});

describe("createIdentityTuning", () => {
  it("returns the frozen defaults when nothing is overridden", () => {
    const tuning = createIdentityTuning();
    expect(tuning).toEqual(IDENTITY_TUNING_DEFAULTS);
    expect(Object.isFrozen(tuning)).toBe(true);
  });

  it("accepts a reservation TTL just above the floor", () => {
    const floor = reservationTtlFloorMs();
    expect(
      createIdentityTuning({ reservationTtlMs: floor + 1 }).reservationTtlMs,
    ).toBe(floor + 1);
  });

  it("rejects a reservation TTL at or below the floor", () => {
    const floor = reservationTtlFloorMs();
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ reservationTtlMs: floor }),
      ),
    ).toBe(true);
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ reservationTtlMs: floor - 1 }),
      ),
    ).toBe(true);
  });

  it("rejects a reset window that is not strictly below the reset token TTL", () => {
    const ttl = DELIVERY_TUNING_DEFAULTS.resetTokenTtlMs;
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ resetRequestWindowMs: ttl }),
      ),
    ).toBe(true);
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ resetRequestWindowMs: ttl + 1 }),
      ),
    ).toBe(true);
    expect(
      createIdentityTuning({ resetRequestWindowMs: ttl - 1 })
        .resetRequestWindowMs,
    ).toBe(ttl - 1);
  });

  it("rejects a non-positive lockout threshold or base width", () => {
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ loginLockoutThreshold: 0 }),
      ),
    ).toBe(true);
    expect(
      configurationErrorFrom(() =>
        createIdentityTuning({ loginLockoutBaseMs: 0 }),
      ),
    ).toBe(true);
  });
});
