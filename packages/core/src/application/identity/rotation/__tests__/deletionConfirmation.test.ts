import { describe, expect, it } from "vitest";
import { confirmDeletion, noopSinceOf } from "../deletionConfirmation";

const DELAY = 60_000;

// TC-keyRotation-024, the pure half: a no-op over two generations is not
// confirmed until the round has been re-issued after the interval.
describe("confirmDeletion", () => {
  it("confirms a single-generation no-op, and any round that deleted rows, at once", () => {
    expect(
      confirmDeletion({
        targets: [{ generation: 1, deleted: false }],
        noopSince: null,
        now: 1_000,
        reissueDelayMs: DELAY,
      }),
    ).toEqual({ kind: "confirmed" });
    expect(
      confirmDeletion({
        targets: [
          { generation: 1, deleted: true },
          { generation: 2, deleted: true },
        ],
        noopSince: null,
        now: 1_000,
        reissueDelayMs: DELAY,
      }),
    ).toEqual({ kind: "confirmed" });
  });

  it("holds a two-generation no-op open for one re-issue after the interval, counted from the first round's end", () => {
    const targets = [
      { generation: 1, deleted: true },
      { generation: 2, deleted: false },
    ];
    const first = confirmDeletion({
      targets,
      noopSince: null,
      now: 1_000,
      reissueDelayMs: DELAY,
    });
    expect(first).toEqual({
      kind: "reissue-after",
      at: 1_000 + DELAY,
      noopSince: 1_000,
    });
    // Woken early: wait for the rest of the interval, the mark unchanged.
    expect(
      confirmDeletion({
        targets,
        noopSince: 1_000,
        now: 1_000 + DELAY / 2,
        reissueDelayMs: DELAY,
      }),
    ).toEqual({
      kind: "reissue-after",
      at: 1_000 + DELAY,
      noopSince: 1_000,
    });
    // The re-issued round after the interval confirms, no-op or not.
    expect(
      confirmDeletion({
        targets,
        noopSince: 1_000,
        now: 1_000 + DELAY,
        reissueDelayMs: DELAY,
      }),
    ).toEqual({ kind: "confirmed" });
  });

  it("reads the mark off the stashed coordinates", () => {
    expect(
      noopSinceOf([{ mapping: "x" }, { mapping: "y", noopSince: 5 }]),
    ).toBe(5);
    expect(noopSinceOf([{ mapping: "x" }])).toBeNull();
    expect(noopSinceOf([])).toBeNull();
  });
});
