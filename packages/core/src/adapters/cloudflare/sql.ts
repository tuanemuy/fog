export type SqlValue = ArrayBuffer | string | number | null;

export interface SqlCursor<Row extends Record<string, SqlValue>> {
  toArray(): Row[];
  one(): Row;
  raw<Value extends SqlValue[]>(): IterableIterator<Value>;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface SqlStorage {
  exec<Row extends Record<string, SqlValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursor<Row>;
}

export interface DurableSqlStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

export function sqliteErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /(?:SQLITE_[A-Z_]+)/u.exec(error.message);
  return match?.[0];
}
