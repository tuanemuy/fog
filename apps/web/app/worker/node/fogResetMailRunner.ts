import type { Logger } from "@repo/core/application/ports/logger";

export function createFogResetMailRunner({
  dispatch,
  logger,
  intervalMs = 5000,
}: {
  dispatch: () => Promise<{ sentCount: number; failedCount: number }>;
  logger: Logger;
  intervalMs?: number;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        const result = await dispatch();
        if (result.sentCount || result.failedCount)
          logger.info("[fog.reset-mail] delivery cycle", result);
      } catch {
        logger.error("[fog.reset-mail] delivery cycle failed");
      }
    })().finally(() => {
      running = undefined;
    });
  };
  return {
    start() {
      if (timer || stopped) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
