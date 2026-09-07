import { describe, expect, it } from "vitest";
import {
  IDENTITY_DIRECTORY_JOB_KINDS,
  JOB_KIND_POLICY,
  type JobKind,
  USER_DATA_JOB_KINDS,
} from "../types";

// The enumerated roster of `jobs.kind`, transcribed from
// `spec/async/index.md`. It is written out here rather than derived from
// the module under test, which is what makes the comparison an assertion
// instead of a tautology.
//
// This is the counterpart, on the `jobs.kind` side, of `rosterGrep.test.ts`,
// which scans the sources for every `jobs.kind` and `event.type` literal
// and checks each against the roster.
const ROSTER_USER_DATA = [
  "purge-trash",
  "reindex",
  "migrate-bulk",
  "finalize-withdrawal",
  "sweep-orphan-mapping",
  "resume-link",
] as const;

const ROSTER_IDENTITY_DIRECTORY = [
  "resume-signup",
  "resume-credential-change",
  "sweep-reservations",
  "sweep-reset-tokens",
  "rotate-encryption",
] as const;

// The five kinds that re-arm themselves on completion. The set does not
// follow from the sub-classification — three are deadline sweeps, one is
// a cross-DO saga advance and one is a chunked bulk job — so it has to be
// declared, and therefore has to be checked.
const ROSTER_REARMING = [
  "purge-trash",
  "sweep-reservations",
  "sweep-reset-tokens",
  "sweep-orphan-mapping",
  "rotate-encryption",
] as const;

const sorted = (values: readonly string[]) => [...values].sort();

describe("jobs.kind roster", () => {
  it("matches the enumerated User Data kinds element for element", () => {
    expect(sorted(USER_DATA_JOB_KINDS)).toEqual(sorted(ROSTER_USER_DATA));
  });

  it("matches the enumerated Identity Directory kinds element for element", () => {
    expect(sorted(IDENTITY_DIRECTORY_JOB_KINDS)).toEqual(
      sorted(ROSTER_IDENTITY_DIRECTORY),
    );
  });

  it("splits eleven kinds six / five between the two DO classes", () => {
    expect(USER_DATA_JOB_KINDS).toHaveLength(6);
    expect(IDENTITY_DIRECTORY_JOB_KINDS).toHaveLength(5);
  });

  // A partial dictionary would let a newly added kind fall through the
  // runner silently, so the table is keyed on all eleven.
  it("declares a policy for every kind and for no other key", () => {
    expect(sorted(Object.keys(JOB_KIND_POLICY))).toEqual(
      sorted([...ROSTER_USER_DATA, ...ROSTER_IDENTITY_DIRECTORY]),
    );
  });

  it("marks exactly the five re-arming kinds as re-arming", () => {
    const rearming = Object.entries(JOB_KIND_POLICY)
      .filter(([, policy]) => policy.rearmsOnCompletion)
      .map(([kind]) => kind);
    expect(sorted(rearming)).toEqual(sorted(ROSTER_REARMING));
  });

  // Convergence rule (3) revives a `done` row only for the re-arming
  // kinds; the other six treat a re-submission as a duplicate request.
  it("revives from `done` exactly the kinds that re-arm", () => {
    for (const kind of Object.keys(JOB_KIND_POLICY) as JobKind[]) {
      expect(JOB_KIND_POLICY[kind].revivesFromDone).toBe(
        JOB_KIND_POLICY[kind].rearmsOnCompletion,
      );
    }
  });

  it("declares the remaining six as not revived from `done`", () => {
    const notRevived = Object.entries(JOB_KIND_POLICY)
      .filter(([, policy]) => !policy.revivesFromDone)
      .map(([kind]) => kind);
    expect(notRevived).toHaveLength(6);
  });
});
