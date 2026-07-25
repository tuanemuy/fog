import { isConflictError, isSystemError } from "@repo/core/application/errors";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mapDbError } from "../repositories/helpers";
import { users } from "../schema";
import { createTestContainer } from "./helpers";

// Pins the SQLITE_CONSTRAINT_* → ConflictError classification end-to-end
// against a real D1 binding. The detection inside `mapDbError` walks the
// driver error chain (`extendedCode` → `code` → message-text fallback)
// and the exact surface depends on D1 / Workers runtime / Drizzle. If any
// of those changes the error format, these tests fire — they are the
// canary for the classification regressing into a generic SystemError.
//
// `registerWithPassword` reads `UNIQUE_VIOLATION` as
// `EMAIL_ALREADY_REGISTERED` (ADR-008), so this classification is the
// foundation that translation stands on.
describe("mapDbError SQLITE_CONSTRAINT_* classification (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  const row = (id: string, email: string) => ({
    id,
    email,
    authMethod: "password",
    passwordHash: "stored-hash",
    ssoProvider: null,
    ssoProviderSubject: null,
    trashRetentionDays: 30,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });

  it("maps SQLITE_CONSTRAINT_PRIMARYKEY to ConflictError(UNIQUE_VIOLATION)", async () => {
    const container = createTestContainer();
    const id = "user-pk-collision";

    await container.db.insert(users).values(row(id, "first@example.com"));

    let caught: unknown;
    try {
      await mapDbError("collision", () =>
        container.db.insert(users).values(row(id, "second@example.com")),
      );
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("UNIQUE_VIOLATION");
    }
  });

  it("maps a users_email_uq violation to ConflictError(UNIQUE_VIOLATION)", async () => {
    const container = createTestContainer();
    const email = "duplicate@example.com";

    await container.db.insert(users).values(row("user-email-a", email));

    let caught: unknown;
    try {
      await mapDbError("collision", () =>
        container.db.insert(users).values(row("user-email-b", email)),
      );
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("UNIQUE_VIOLATION");
    }
  });

  it("maps a CHECK violation to ConflictError(CONSTRAINT_VIOLATION)", async () => {
    const container = createTestContainer();

    // `_occ_guard` enforces `n > 0`. Inserting n=0 outside the deferred-
    // batch UoW path bypasses `isOccGuardViolation`'s special case and
    // surfaces the CHECK as a generic constraint violation.
    let caught: unknown;
    try {
      await mapDbError("check violation", () =>
        container.db.run(sql`INSERT INTO _occ_guard (n) VALUES (0)`),
      );
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("CONSTRAINT_VIOLATION");
    }
  });

  it("falls through to SystemError(DATABASE_ERROR) for non-constraint failures", async () => {
    const container = createTestContainer();

    let caught: unknown;
    try {
      await mapDbError("missing table", () =>
        container.db.run(sql`SELECT * FROM does_not_exist`),
      );
    } catch (error) {
      caught = error;
    }

    expect(isSystemError(caught)).toBe(true);
    if (isSystemError(caught)) {
      expect(caught.code).toBe("DATABASE_ERROR");
    }
  });
});
