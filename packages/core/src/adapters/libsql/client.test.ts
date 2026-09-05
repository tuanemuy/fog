import type { Client } from "@libsql/client";
import { expect, it, vi } from "vitest";
import { applyPragmas } from "./client";

it("keeps cloud journal settings while enabling foreign keys", async () => {
  const execute = vi.fn().mockResolvedValue({});
  await applyPragmas({ protocol: "https", execute } as unknown as Client);
  expect(execute.mock.calls).toEqual([["PRAGMA foreign_keys = ON"]]);
});
it("applies local durability and contention settings", async () => {
  const execute = vi.fn().mockResolvedValue({});
  await applyPragmas({ protocol: "file", execute } as unknown as Client);
  expect(execute.mock.calls).toEqual([
    ["PRAGMA journal_mode = WAL"],
    ["PRAGMA foreign_keys = ON"],
    ["PRAGMA busy_timeout = 5000"],
  ]);
});
