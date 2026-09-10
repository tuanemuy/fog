import { describe, expect, it } from "vitest";
import type { RotationCheckpoint } from "../../../execution/unitOfWork";
import { isRetired } from "../retirement";

function checkpoint(
  overrides: Partial<RotationCheckpoint> & { bucketIndex: number },
): RotationCheckpoint {
  return {
    rotationKind: "remap",
    generation: 1,
    previousCount: 0,
    scannedAt: 1,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictCredentialId: null,
    ...overrides,
  };
}

const allZero = (n: number, extra: Partial<RotationCheckpoint> = {}) =>
  Array.from({ length: n }, (_, i) => checkpoint({ bucketIndex: i, ...extra }));

// TC-keyRotation-018 / 030: the condition is "every bucket of the retiring
// generation's count, filtered by kind, all zero" and nothing weaker.
describe("isRetired", () => {
  it("holds only once every bucket has a zero checkpoint", () => {
    expect(isRetired(allZero(4), "remap", 1, 4)).toBe(true);
    expect(isRetired(allZero(3), "remap", 1, 4)).toBe(false);
    expect(
      isRetired(
        [...allZero(3), checkpoint({ bucketIndex: 3, previousCount: 1 })],
        "remap",
        1,
        4,
      ),
    ).toBe(false);
    expect(isRetired([], "remap", 1, 4)).toBe(false);
  });

  it("filters by kind: encryption checkpoints do not vouch for the mapping key", () => {
    const encryption = allZero(4, { rotationKind: "encryption" });
    expect(isRetired(encryption, "remap", 1, 4)).toBe(false);
    expect(isRetired(encryption, "encryption", 1, 4)).toBe(true);
    // Mixed in with three real ones, the fourth being the other kind.
    expect(
      isRetired(
        [
          ...allZero(3),
          checkpoint({ bucketIndex: 3, rotationKind: "encryption" }),
        ],
        "remap",
        1,
        4,
      ),
    ).toBe(false);
  });

  it("filters by generation", () => {
    expect(isRetired(allZero(4, { generation: 2 }), "remap", 1, 4)).toBe(false);
  });

  it("counts with the caller's bucket count: 4 retiring buckets against an 8-bucket active generation, and the reverse", () => {
    // The retiring generation has four buckets: four zero checkpoints retire it.
    expect(isRetired(allZero(4), "remap", 1, 4)).toBe(true);
    // Counted with the active side's eight, it never retires.
    expect(isRetired(allZero(4), "remap", 1, 8)).toBe(false);
    // The reverse configuration: eight retiring buckets, only the first
    // four scanned — counting with the active side's four retires early.
    expect(isRetired(allZero(4), "remap", 1, 8)).toBe(false);
    expect(isRetired(allZero(8), "remap", 1, 8)).toBe(true);
    expect(isRetired(allZero(8), "remap", 1, 0)).toBe(false);
  });
});
