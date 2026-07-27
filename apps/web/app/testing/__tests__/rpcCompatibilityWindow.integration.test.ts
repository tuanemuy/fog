import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type CompatibilityBindings = {
  RPC_STATE_OLD: Fetcher;
  RPC_STATE_NEW: Fetcher;
};

const bindings = env as unknown as CompatibilityBindings;

function mutate(
  state: Fetcher,
  version: number,
  operationId: string,
  value: string,
): Promise<Response> {
  return state.fetch("https://state.test/mutate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, operationId, value }),
  });
}

async function stored(state: Fetcher, operationId: string): Promise<unknown> {
  const response = await state.fetch(
    `https://state.test/operation?operationId=${operationId}`,
  );
  return response.json();
}

describe("request/state RPC deployment compatibility window", () => {
  it("keeps old request, new request, and request rollback safe across state deployment", async () => {
    const oldRequest = crypto.randomUUID();
    const oldAgainstNew = await mutate(
      bindings.RPC_STATE_NEW,
      1,
      oldRequest,
      "old-request",
    );
    expect(oldAgainstNew.status).toBe(200);

    const newRequest = crypto.randomUUID();
    const newAgainstNew = await mutate(
      bindings.RPC_STATE_NEW,
      2,
      newRequest,
      "new-request",
    );
    expect(newAgainstNew.status).toBe(200);

    const rejectedOperation = crypto.randomUUID();
    const newAgainstOld = await mutate(
      bindings.RPC_STATE_OLD,
      2,
      rejectedOperation,
      "must-not-commit",
    );
    expect(newAgainstOld.status).toBe(409);
    expect(await newAgainstOld.json()).toEqual({
      error: "RPC_VERSION_UNSUPPORTED",
      retryable: false,
    });
    expect(await stored(bindings.RPC_STATE_OLD, rejectedOperation)).toEqual({
      value: null,
    });

    const rolledBack = await mutate(
      bindings.RPC_STATE_NEW,
      1,
      newRequest,
      "rolled-back-request",
    );
    expect(rolledBack.status).toBe(200);
    expect(await stored(bindings.RPC_STATE_NEW, newRequest)).toEqual({
      value: "rolled-back-request",
    });
  });
});
