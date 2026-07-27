import type { Logger } from "../ports/logger";

type LogEntry = Readonly<{
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}>;

export class FakeLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "debug", message, ...(meta ? { meta } : {}) });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "info", message, ...(meta ? { meta } : {}) });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", message, ...(meta ? { meta } : {}) });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "error", message, ...(meta ? { meta } : {}) });
  }

  byLevel(level: LogEntry["level"]): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}
