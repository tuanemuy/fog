import { createControlledPromise } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFogRetentionRunner } from "./fogRetentionRunner";

afterEach(() => vi.useRealTimers());
describe("trash retention lifecycle", () => {
  it("sweeps on startup and a timer without requests, skips overlap, and drains before stopping", async () => {
    vi.useFakeTimers();
    const pending = createControlledPromise<{ deletedCount: number }>();
    const purge = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ deletedCount: 0 });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = createFogRetentionRunner({
      purge,
      logger,
      intervalMs: 1000,
    });
    runner.start();
    runner.start();
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(purge).toHaveBeenCalledTimes(1);
    pending.resolve({ deletedCount: 2 });
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(2);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), {
      deletedCount: 2,
    });
  });
  it("records a failure and retries the next scheduled sweep", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    const purge = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ deletedCount: 1 });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = createFogRetentionRunner({
      purge,
      logger,
      intervalMs: 1000,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
      cause: error,
    });
    await runner.stop();
  });
});
