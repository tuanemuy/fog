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
  // (30 s); forward plus cleanup is 60 s, plus the 2 s margin.
  it("is 62,000 ms with the default delivery tuning", () => {
    expect(reservationTtlFloorMs()).toBe(62_000);
    expect(reservationTtlFloorMs(DELIVERY_TUNING_DEFAULTS)).toBe(62_000);
  });

  it("moves with the job runner's backoff", () => {
    expect(
      reservationTtlFloorMs({
        ...DELIVERY_TUNING_DEFAULTS,
        jobsMaxAttempts: 2,
      }),
    ).toBe(2 * 2_000 + 2_000);
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
