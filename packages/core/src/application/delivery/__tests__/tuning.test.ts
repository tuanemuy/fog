import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  createDeliveryTuning,
  DELIVERY_TUNING_DEFAULTS,
  type DeliveryTuning,
} from "../tuning";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// The floor the third check puts under `queueMaxRetryPeriodMs`, computed
// from the declared consumer settings — 3 × (0 + 30,000). Pinned from both
// sides below, so that moving one of those declarations lands here rather
// than leaving the number quoted in the JSDoc and the runbook behind.
// Which side of the floor is inclusive is deliberately left unpinned: the
// two tests below fix the number and the rejection below it, and whether
// exactly the floor is accepted changes no operator action and no design
// decision.
const QUEUE_RETRY_FLOOR_MS = 90_000;

describe("createDeliveryTuning", () => {
  it("accepts the declared defaults", () => {
    const tuning = createDeliveryTuning();
    expect(tuning).toEqual(DELIVERY_TUNING_DEFAULTS);
  });

  // Constraint 1 of 2: a functional requirement read against a conservative
  // upper bound — the second term is the worst-case age of a message on its
  // way to the DLQ handler, and the link has to still work at the end of it.
  it("rejects a budget that reaches the reset-token TTL", () => {
    const error = capture(() =>
      createDeliveryTuning({
        queueMaxRetryPeriodMs: 600_000,
        dlqRetentionMs: 600_000,
        resetTokenTtlMs: 1_200_000,
      }),
    );
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CONFIGURATION_ERROR");
  });

  // Constraint 2 of 2: the send-materials guard requires the row to exist, so
  // a delivery arriving after the prune removed it can only ever miss.
  it("rejects a budget that exceeds the published retention", () => {
    const error = capture(() =>
      createDeliveryTuning({
        queueMaxRetryPeriodMs: 600_000,
        dlqRetentionMs: 600_000,
        publishedRetentionMs: 1_000_000,
      }),
    );
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CONFIGURATION_ERROR");
  });

  // The left-hand side of both constraints is itself anchored: the
  // declared retry period has to cover the retries the consumer config
  // already buys, so the retry count and the period cannot be raised
  // independently of each other.
  it("rejects a retry budget the declared retry period cannot cover", () => {
    const error = capture(() =>
      createDeliveryTuning({
        eventsMaxRetries: 6,
        eventsRetryDelayMs: 30_000,
      }),
    );
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CONFIGURATION_ERROR");
  });

  it("accepts the same retries once the retry period is raised with them", () => {
    const tuning = createDeliveryTuning({
      eventsMaxRetries: 6,
      eventsRetryDelayMs: 30_000,
      queueMaxRetryPeriodMs: 360_000,
    });
    expect(tuning.queueMaxRetryPeriodMs).toBe(360_000);
  });

  it("declares a retry period that covers the declared consumer settings", () => {
    const tuning = createDeliveryTuning();
    expect(tuning.queueMaxRetryPeriodMs).toBeGreaterThanOrEqual(
      tuning.eventsMaxRetries *
        (tuning.eventsRetryDelayMs + tuning.eventsMaxBatchTimeoutMs),
    );
  });

  it("puts the declared consumer settings at the quoted floor", () => {
    const tuning = createDeliveryTuning();
    expect(
      tuning.eventsMaxRetries *
        (tuning.eventsRetryDelayMs + tuning.eventsMaxBatchTimeoutMs),
    ).toBe(QUEUE_RETRY_FLOOR_MS);
  });

  it("rejects a retry period one millisecond below that floor", () => {
    const error = capture(() =>
      createDeliveryTuning({
        queueMaxRetryPeriodMs: QUEUE_RETRY_FLOOR_MS - 1,
      }),
    );
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CONFIGURATION_ERROR");
  });

  it("accepts a budget that satisfies both constraints", () => {
    const tuning = createDeliveryTuning({
      queueMaxRetryPeriodMs: 600_000,
      dlqRetentionMs: 600_000,
      resetTokenTtlMs: 1_200_001,
      publishedRetentionMs: 1_200_000,
    });
    expect(tuning.resetTokenTtlMs).toBe(1_200_001);
  });
});

describe("delivery tuning declares every bound it is required to carry", () => {
  const tuning = createDeliveryTuning();

  // The three-tier bound on how much one wake-up touches. The middle one
  // is the threshold that makes "return the row to `pending` and release
  // the lease" implementable at all.
  it.each([
    ["jobsMaxJobsPerPass"],
    ["jobsMaxChunkIterations"],
    ["jobsMaxRowsPerChunk"],
  ] as const)("carries the count limit %s", (key) => {
    expect(typeof tuning[key as keyof DeliveryTuning]).toBe("number");
    expect(tuning[key as keyof DeliveryTuning]).toBeGreaterThan(0);
  });

  // The measured Cloudflare Queue ceilings. Only the per-message one can
  // bite while the relay publishes row by row; all three are carried so a
  // later move to `sendBatch` cannot overlook one.
  it("carries the three measured queue ceilings", () => {
    expect(tuning.queueMaxBatchCount).toBe(100);
    expect(tuning.queueMaxBatchBytes).toBe(288_000);
    expect(tuning.queueMaxMessageBytes).toBe(128_000);
  });

  // No backoff is applied to the fail-closed interval, so it is a plain
  // value rather than a base for one.
  it("carries a fixed fail-closed re-arm interval", () => {
    expect(tuning.failClosedRearmIntervalMs).toBeGreaterThan(0);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially from the base", () => {
    expect(backoffDelayMs(0, 1000, 60_000)).toBe(1000);
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 60_000)).toBe(8000);
  });

  it("is capped", () => {
    expect(backoffDelayMs(30, 1000, 60_000)).toBe(60_000);
  });
});
