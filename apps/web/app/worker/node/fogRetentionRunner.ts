import type { Logger } from "@repo/core/application/ports/logger";

export function createFogRetentionRunner({
  purge,
  logger,
  intervalMs = 60_000,
}: {
  purge: () => Promise<{ deletedCount: number }>;
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
        const { deletedCount } = await purge();
        if (deletedCount)
          logger.info("[fog.retention] expired trash deleted", {
            deletedCount,
          });
      } catch (cause) {
        logger.error("[fog.retention] sweep failed", { cause });
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
