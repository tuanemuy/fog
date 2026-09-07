import { describe, expect, it } from "vitest";
import {
  IDENTITY_DIRECTORY_PLAN,
  IDENTITY_DIRECTORY_TABLE_NAMES,
} from "../schema/identityDirectoryPlan";
import { USER_DATA_PLAN, USER_DATA_TABLE_NAMES } from "../schema/userDataPlan";

// The counts are `spec/database/index.md`'s: seventeen User Data tables
// (sixteen plus the FTS5 virtual table) and seven Identity Directory tables.
describe("schema plans", () => {
  it("declares the seventeen User Data tables", () => {
    expect(USER_DATA_TABLE_NAMES).toHaveLength(17);
    expect(new Set(USER_DATA_TABLE_NAMES).size).toBe(17);
  });

  it("declares the seven Identity Directory tables", () => {
    expect(IDENTITY_DIRECTORY_TABLE_NAMES).toHaveLength(7);
    expect(new Set(IDENTITY_DIRECTORY_TABLE_NAMES).size).toBe(7);
  });

  it("both classes carry the shared meta and asynchronous-work tables", () => {
    for (const name of ["_meta", "jobs", "outbox_events"] as const) {
      expect(USER_DATA_TABLE_NAMES).toContain(name);
      expect(IDENTITY_DIRECTORY_TABLE_NAMES).toContain(name);
    }
  });

  it.each([
    ["User Data", USER_DATA_PLAN],
    ["Identity Directory", IDENTITY_DIRECTORY_PLAN],
  ])("the %s plan is at version 1 with a single step", (_label, plan) => {
    expect(plan.targetVersion).toBe(1);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.version).toBe(1);
    expect(typeof plan.steps[0]?.apply).toBe("function");
  });
});
