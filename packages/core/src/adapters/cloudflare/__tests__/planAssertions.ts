type PlanRow = Readonly<{ id: number; parent: number; detail: string }>;

/**
 * `EXPLAIN QUERY PLAN` for one statement, on the DO's SQLite, as the
 * `detail` lines. Every `?` is bound to `0`: the DO's `exec` insists on a
 * full binding, while the planner never reads the values — a partial
 * index is chosen by the statement's text.
 */
export function queryPlan(sql: SqlStorage, statement: string): string[] {
  const placeholders = statement.split("?").length - 1;
  return sql
    .exec<PlanRow>(
      `EXPLAIN QUERY PLAN ${statement}`,
      ...Array.from({ length: placeholders }, () => 0),
    )
    .toArray()
    .map((row) => row.detail);
}

/** The plan seeks through `index` and touches no full table `SCAN`. */
export function expectIndexSeek(plan: string[], index: string): void {
  const seeks = plan.filter((line) => line.includes(`INDEX ${index}`));
  if (seeks.length === 0) {
    throw new Error(
      `expected a seek through ${index}, got:\n${plan.join("\n")}`,
    );
  }
  const scans = plan.filter((line) => line.startsWith("SCAN"));
  if (scans.length > 0) {
    throw new Error(`expected no table scan, got:\n${plan.join("\n")}`);
  }
}

/** The plan is a row-key seek (a `SEARCH` on the table's key) and touches no `SCAN`. */
export function expectKeySeek(plan: string[], table: string): void {
  const seeks = plan.filter(
    (line) =>
      line.startsWith(`SEARCH ${table} USING`) &&
      (line.includes("PRIMARY KEY") || line.includes("sqlite_autoindex")),
  );
  if (seeks.length === 0) {
    throw new Error(
      `expected a key seek on ${table}, got:\n${plan.join("\n")}`,
    );
  }
  const scans = plan.filter((line) => line.startsWith("SCAN"));
  if (scans.length > 0) {
    throw new Error(`expected no table scan, got:\n${plan.join("\n")}`);
  }
}
