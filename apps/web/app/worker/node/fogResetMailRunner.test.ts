import { afterEach, expect, it, vi } from "vitest";
import { createFogResetMailRunner } from "./fogResetMailRunner";

afterEach(() => vi.useRealTimers());
it("runs without HTTP, prevents overlap, and drains before stopping", async () => {
  vi.useFakeTimers();
  let finish:
    | ((value: { sentCount: number; failedCount: number }) => void)
    | undefined;
  const work = new Promise<{ sentCount: number; failedCount: number }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const dispatch = vi.fn().mockReturnValue(work);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runner = createFogResetMailRunner({ dispatch, logger });
  runner.start();
  runner.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(dispatch).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish?.({ sentCount: 1, failedCount: 0 });
  await stopping;
  expect(stopped).toBe(true);
  await vi.advanceTimersByTimeAsync(15000);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("retries on the next interval and never logs the thrown secret payload", async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn()
    .mockRejectedValueOnce(new Error("secret-reset-url"))
    .mockResolvedValue({ sentCount: 0, failedCount: 0 });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runner = createFogResetMailRunner({ dispatch, logger });
  runner.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
    "secret-reset-url",
  );
  await runner.stop();
});
