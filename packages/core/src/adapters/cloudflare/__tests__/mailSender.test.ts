import type { Fetcher } from "@cloudflare/workers-types";
import { isSystemError } from "@repo/core/application/errors";
import type { Logger, LogMeta } from "@repo/core/application/ports/logger";
import type { Email } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { createBindingMailSender, createNoopMailSender } from "../mailSender";
import { assertNoForbiddenValue } from "./forbiddenValues";

const TO = "user@example.com" as Email;
const TOKEN = "reset-token-secret";

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, meta?: LogMeta) => {
    lines.push(message);
    if (meta !== undefined) lines.push(JSON.stringify(meta));
  };
  return { lines, logger: { info: push, warn: push, error: push } };
}

function stubFetcher(response: Response): {
  fetcher: Fetcher;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = {
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(response);
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

describe("createBindingMailSender", () => {
  it("posts the reset URL built from APP_URL", async () => {
    const { fetcher, calls } = stubFetcher(new Response(null, { status: 202 }));
    const { logger } = recordingLogger();
    const sender = createBindingMailSender(
      fetcher,
      "https://app.example.test",
      logger,
    );
    await sender.sendPasswordResetMail(TO, TOKEN);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.resetUrl).toBe(
      `https://app.example.test/reset-password?token=${TOKEN}`,
    );
    expect(body.to).toBe(TO);
  });

  it("carries a deterministic Idempotency-Key", async () => {
    const first = stubFetcher(new Response(null, { status: 202 }));
    const second = stubFetcher(new Response(null, { status: 202 }));
    const { logger } = recordingLogger();
    const url = "https://app.example.test";
    await createBindingMailSender(
      first.fetcher,
      url,
      logger,
    ).sendPasswordResetMail(TO, TOKEN);
    await createBindingMailSender(
      second.fetcher,
      url,
      logger,
    ).sendPasswordResetMail(TO, TOKEN);
    const keyOf = (call: { init: RequestInit }) =>
      (call.init.headers as Record<string, string>)["Idempotency-Key"];
    expect(keyOf(first.calls[0] as never)).toBe(
      keyOf(second.calls[0] as never),
    );
    expect(keyOf(first.calls[0] as never)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("raises a SystemError without leaking the recipient into the log", async () => {
    const { fetcher } = stubFetcher(
      new Response("rejected: user@example.com", { status: 500 }),
    );
    const { logger, lines } = recordingLogger();
    const sender = createBindingMailSender(
      fetcher,
      "https://app.example.test",
      logger,
    );
    let caught: unknown;
    try {
      await sender.sendPasswordResetMail(TO, TOKEN);
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    assertNoForbiddenValue(lines);
  });
});

describe("createNoopMailSender", () => {
  it("warns on every call and resolves", async () => {
    const { logger, lines } = recordingLogger();
    const sender = createNoopMailSender(logger);
    await sender.sendPasswordResetMail(TO, TOKEN);
    await sender.sendPasswordResetMail(TO, TOKEN);
    expect(lines).toHaveLength(2);
    assertNoForbiddenValue(lines);
  });
});
