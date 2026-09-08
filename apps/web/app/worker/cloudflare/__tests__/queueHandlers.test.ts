import type { OutboxQueueMessage } from "@repo/core/adapters/cloudflare/queueMessage";
import type { SendMailMaterials } from "@repo/core/application/delivery/types";
import type { QueueContainer } from "@repo/core/application/di/serverCloudflare";
import type { Logger, LogMeta } from "@repo/core/application/ports/logger";
import { describe, expect, it, vi } from "vitest";
import { handleDlqBatch, handleEventsBatch } from "../queueHandlers";

type Entry = Readonly<{
  level: string;
  message: string;
  meta: LogMeta | undefined;
}>;

function fakeLogger(entries: Entry[]): Logger {
  return {
    info: (message, meta) => entries.push({ level: "info", message, meta }),
    warn: (message, meta) => entries.push({ level: "warn", message, meta }),
    error: (message, meta) => entries.push({ level: "error", message, meta }),
  };
}

type FakeMessage = Message<OutboxQueueMessage> & {
  acked: boolean;
  retried: boolean;
};

function message(body: Partial<OutboxQueueMessage>): FakeMessage {
  const m = {
    id: "m1",
    timestamp: new Date(),
    attempts: 1,
    body: {
      eventId: "evt-1",
      type: "identity.passwordResetRequested",
      payload: { tokenId: "t", mailKind: "password-reset" },
      routingKey: "dir:g1:b0",
      ownerToken: "o".repeat(32),
      ...body,
    },
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
  return m as unknown as FakeMessage;
}

function batch(
  queue: string,
  messages: FakeMessage[],
): MessageBatch<OutboxQueueMessage> & {
  ackedAll: boolean;
  retriedAll: boolean;
} {
  const b = {
    queue,
    messages,
    ackedAll: false,
    retriedAll: false,
    ackAll() {
      this.ackedAll = true;
    },
    retryAll() {
      this.retriedAll = true;
    },
  };
  return b as unknown as MessageBatch<OutboxQueueMessage> & {
    ackedAll: boolean;
    retriedAll: boolean;
  };
}

function container(
  entries: Entry[],
  materials: () => Promise<SendMailMaterials>,
  send = vi.fn<(to: string, token: string, key: string) => Promise<void>>(),
): { container: QueueContainer; send: typeof send; stubCalls: unknown[] } {
  const stubCalls: unknown[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      async getResetMailMaterials(input: unknown) {
        stubCalls.push(input);
        try {
          return { ok: true, value: await materials() };
        } catch (error) {
          return {
            ok: false,
            error: {
              kind: "system",
              code: "DATABASE_ERROR",
              message: String(error),
              retryable: true,
            },
          };
        }
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    container: {
      mailSender: { sendPasswordResetMail: send },
      logger: fakeLogger(entries),
      bindings: { USER_DATA: namespace, IDENTITY_DIRECTORY: namespace },
    },
    send,
    stubCalls,
  };
}

describe("handleEventsBatch", () => {
  it("asks the bucket for the materials with the owner token and sends, then acks", async () => {
    const entries: Entry[] = [];
    const {
      container: c,
      send,
      stubCalls,
    } = container(entries, async () => ({
      kind: "send",
      to: "to@example.com",
      resetToken: "1.0.secret",
      providerIdempotencyKey: "idem",
    }));
    const m = message({});
    await handleEventsBatch(batch("events", [m]), c);
    expect(stubCalls).toEqual([
      { eventId: "evt-1", ownerToken: "o".repeat(32) },
    ]);
    expect(send).toHaveBeenCalledWith("to@example.com", "1.0.secret", "idem");
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("acks nothing-to-send without sending", async () => {
    const entries: Entry[] = [];
    const { container: c, send } = container(entries, async () => ({
      kind: "nothing-to-send",
    }));
    const m = message({});
    await handleEventsBatch(batch("events", [m]), c);
    expect(send).not.toHaveBeenCalled();
    expect(m.acked).toBe(true);
  });

  it("retries an unserved type and an unserved routing key, logging only id and type", async () => {
    const entries: Entry[] = [];
    const { container: c, stubCalls } = container(entries, async () => ({
      kind: "nothing-to-send",
    }));
    const wrongType = message({ type: "something.else" });
    const wrongKey = message({ eventId: "evt-2", routingKey: "u:user-1" });
    await handleEventsBatch(batch("events", [wrongType, wrongKey]), c);
    expect(wrongType.retried).toBe(true);
    expect(wrongKey.retried).toBe(true);
    expect(stubCalls).toEqual([]);
    for (const entry of entries) {
      expect(Object.keys(entry.meta ?? {}).sort()).toEqual(["eventId", "type"]);
    }
  });

  it("retries when the send fails and never logs the message or the token", async () => {
    const entries: Entry[] = [];
    const send = vi.fn(async () => {
      throw new Error("provider down");
    });
    const { container: c } = container(
      entries,
      async () => ({
        kind: "send",
        to: "to@example.com",
        resetToken: "1.0.secret",
        providerIdempotencyKey: "idem",
      }),
      send,
    );
    const m = message({});
    await handleEventsBatch(batch("events", [m]), c);
    expect(m.retried).toBe(true);
    expect(m.acked).toBe(false);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("1.0.secret");
    expect(logged).not.toContain("to@example.com");
    expect(logged).not.toContain("o".repeat(32));
    expect(logged).toContain("evt-1");
  });

  it("retries when the bucket cannot be reached", async () => {
    const entries: Entry[] = [];
    const { container: c } = container(entries, async () => {
      throw new Error("DO died");
    });
    const m = message({});
    await handleEventsBatch(batch("events", [m]), c);
    expect(m.retried).toBe(true);
  });
});

describe("handleDlqBatch", () => {
  it("acks every message after a warning that carries only id and type", () => {
    const entries: Entry[] = [];
    const a = message({ eventId: "evt-a" });
    const b = message({ eventId: "evt-b", type: "x" });
    handleDlqBatch(batch("events-dlq", [a, b]), fakeLogger(entries));
    expect(a.acked && b.acked).toBe(true);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "dlq",
        meta: { eventId: "evt-a", type: "identity.passwordResetRequested" },
      },
      { level: "warn", message: "dlq", meta: { eventId: "evt-b", type: "x" } },
    ]);
    expect(JSON.stringify(entries)).not.toContain("o".repeat(32));
  });
});
