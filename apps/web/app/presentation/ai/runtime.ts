import { getContainer } from "@repo/core/application/di/containerStore";
import type { AiRuntime } from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";

/**
 * The AI runtime (token codec) rides beside the request container rather
 * than on it: `RequestContainer` is the usecase container every test
 * fixture builds, and the codec is presentation material. The entry point
 * attaches it per request; the P-14 server functions read it back through
 * the same request scope `getContainer()` resolves.
 */
const runtimes = new WeakMap<RequestContainer, AiRuntime>();

export function attachAiRuntime(
  container: RequestContainer,
  runtime: AiRuntime,
): void {
  runtimes.set(container, runtime);
}

export async function getAiRuntime(): Promise<AiRuntime> {
  const container = await getContainer();
  const runtime = runtimes.get(container);
  if (runtime === undefined) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "The AI runtime was not attached to this request",
    );
  }
  return runtime;
}
