/** One coordinate a deletion saga issued `deleteMapping` to, and whether a row actually went. */
export type DeletionTarget = Readonly<{
  generation: number;
  deleted: boolean;
}>;

export type DeletionVerdict =
  | Readonly<{ kind: "confirmed" }>
  | Readonly<{
      kind: "reissue-after";
      /** When the saga runs again to re-issue; the record keeps `noopSince`. */
      at: number;
      noopSince: number;
    }>;

/**
 * "Confirmation of a no-op deletion" (`spec/rotation/index.md`, 削除の
 * no-op 確定): when may a deletion saga — `sweep-orphan-mapping` for an
 * unlink, `finalize-withdrawal` for a withdrawal — close its record after
 * issuing "absent is success" deletions to every stashed coordinate.
 *
 * A deletion that removed a row confirms at once. A no-op confirms at
 * once too when the stashed coordinates lie in one generation. When they
 * span two — the mark that s3 of a transfer recorded a new-generation
 * coordinate on this credential — a no-op may have been overtaken by an
 * import still in flight, so the saga re-issues the round once after
 * `reissueDelayMs`, counted from the end of the **first full round**
 * (`noopSince`), and confirms then: the copy that landed in between is
 * visible to the second round and is really deleted.
 *
 * `reissueDelayMs` is `DeliveryTuning.deleteNoopReissueDelayMs`, and its
 * limit is stated there.
 */
export function confirmDeletion(input: {
  targets: readonly DeletionTarget[];
  noopSince: number | null;
  now: number;
  reissueDelayMs: number;
}): DeletionVerdict {
  if (deletionRoundConfirms(input.targets)) return { kind: "confirmed" };
  if (input.noopSince === null) {
    return {
      kind: "reissue-after",
      at: input.now + input.reissueDelayMs,
      noopSince: input.now,
    };
  }
  if (input.now - input.noopSince >= input.reissueDelayMs) {
    return { kind: "confirmed" };
  }
  return {
    kind: "reissue-after",
    at: input.noopSince + input.reissueDelayMs,
    noopSince: input.noopSince,
  };
}

/**
 * Whether one round of deletions confirms on its own: the coordinates lie
 * in a single generation, or every deletion removed a row. What is left
 * over is the two-generation no-op that has to be re-issued.
 */
export function deletionRoundConfirms(
  targets: readonly DeletionTarget[],
): boolean {
  const generations = new Set(targets.map((t) => t.generation));
  return generations.size <= 1 || targets.every((t) => t.deleted);
}

/** The `noopSince` a record's stashed coordinates carry, if a first round already ended in a no-op. */
export function noopSinceOf(targets: readonly unknown[]): number | null {
  for (const target of targets) {
    if (
      typeof target === "object" &&
      target !== null &&
      "noopSince" in target &&
      typeof target.noopSince === "number"
    ) {
      return target.noopSince;
    }
  }
  return null;
}
