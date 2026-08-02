import { JOB_KINDS, JOB_OWNER } from "@repo/core/lib/jobKind";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_DIRECTORY_JOB_HANDLERS,
  USER_DATA_JOB_HANDLERS,
} from "../registry";

// ADR-002 fixes the counts: 12 kinds are declared, 7 get handlers. The gap of
// 5 (`finalize-withdrawal` / `resume-link` / `resume-credential-change` /
// `sweep-orphan-mapping` / `rotate-encryption`) belongs to #12 / #44 / #45,
// and pinning the number is what keeps it from drifting silently.
//
const EXPECTED_USER_DATA_HANDLERS = ["migrate-bulk", "purge-trash", "reindex"];
const EXPECTED_DIRECTORY_HANDLERS = [
  "resume-signup",
  "send-mail",
  "sweep-reservations",
  "sweep-reset-tokens",
];

describe("job handler registries", () => {
  it("registers only kinds owned by the corresponding DO class", () => {
    for (const kind of Object.keys(USER_DATA_JOB_HANDLERS)) {
      expect(JOB_OWNER[kind as keyof typeof JOB_OWNER]).toBe("userData");
    }
    for (const kind of Object.keys(IDENTITY_DIRECTORY_JOB_HANDLERS)) {
      expect(JOB_OWNER[kind as keyof typeof JOB_OWNER]).toBe(
        "identityDirectory",
      );
    }
  });

  it("never registers a kind that is not declared", () => {
    const declared = new Set<string>(JOB_KINDS);
    for (const kind of [
      ...Object.keys(USER_DATA_JOB_HANDLERS),
      ...Object.keys(IDENTITY_DIRECTORY_JOB_HANDLERS),
    ]) {
      expect(declared.has(kind)).toBe(true);
    }
  });

  it("leaves the five out-of-scope kinds unregistered", () => {
    const registered = new Set([
      ...Object.keys(USER_DATA_JOB_HANDLERS),
      ...Object.keys(IDENTITY_DIRECTORY_JOB_HANDLERS),
    ]);
    for (const kind of [
      "finalize-withdrawal",
      "resume-link",
      "resume-credential-change",
      "sweep-orphan-mapping",
      "rotate-encryption",
    ]) {
      expect(registered.has(kind)).toBe(false);
    }
  });

  it("registers exactly the planned 3 / 4 split", () => {
    expect(Object.keys(USER_DATA_JOB_HANDLERS).sort()).toEqual(
      EXPECTED_USER_DATA_HANDLERS,
    );
    expect(Object.keys(IDENTITY_DIRECTORY_JOB_HANDLERS).sort()).toEqual(
      EXPECTED_DIRECTORY_HANDLERS,
    );
  });
});
