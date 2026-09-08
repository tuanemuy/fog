import type { ServerEnv } from "@repo/core/application/di/serverCloudflare";
import type { Logger, LogMeta } from "@repo/core/application/ports/logger";
import { describe, expect, it } from "vitest";
import {
  handleOperator,
  OPERATOR_ENTRIES,
  type OperatorDeps,
} from "../operatorHandlers";

const TOKEN = "operator-token-for-tests-0123456789abcdef";
const USER = "01950000-0000-7000-8000-000000000001";

type Call = Readonly<{ name: string; method: string; args: unknown[] }>;
type Entry = Readonly<{
  level: string;
  message: string;
  meta: LogMeta | undefined;
}>;

function fakeEnv(
  calls: Call[],
  answer: (method: string) => unknown = () => ({
    ok: true,
    value: { fine: true },
  }),
  token: string | null = TOKEN,
): ServerEnv {
  const namespace = (label: string) =>
    ({
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) =>
        new Proxy(
          {},
          {
            get:
              (_t, method: string) =>
              async (...args: unknown[]) => {
                calls.push({ name: `${label}:${id.name}`, method, args });
                return answer(method);
              },
          },
        ),
    }) as unknown as DurableObjectNamespace;
  return {
    USER_DATA: namespace("user"),
    IDENTITY_DIRECTORY: namespace("dir"),
    ...(token === null ? {} : { OPERATOR_TOKEN: token }),
  } as ServerEnv;
}

function logger(entries: Entry[]): Logger {
  return {
    info: (message, meta) => entries.push({ level: "info", message, meta }),
    warn: (message, meta) => entries.push({ level: "warn", message, meta }),
    error: (message, meta) => entries.push({ level: "error", message, meta }),
  };
}

function post(
  entry: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  method = "POST",
): Request {
  return new Request(`http://localhost:3000/__operator/${entry}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function deps(env: ServerEnv, entries: Entry[] = []): OperatorDeps {
  return { env, logger: logger(entries) };
}

describe("POST /__operator/<entry>", () => {
  it("does not exist without the token, refuses a wrong or short one, and a wrong method", async () => {
    const calls: Call[] = [];
    expect(
      (
        await handleOperator(
          post("read-schema-version", { locator: "dir:g1:b0" }),
          deps(fakeEnv(calls, undefined, null)),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleOperator(
          post("read-schema-version", { locator: "dir:g1:b0" }),
          deps(fakeEnv(calls, undefined, "short")),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleOperator(
          post(
            "read-schema-version",
            { locator: "dir:g1:b0" },
            { authorization: "Bearer nope" },
          ),
          deps(fakeEnv(calls)),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleOperator(
          post("read-schema-version", {}, {}, "GET"),
          deps(fakeEnv(calls)),
        )
      ).status,
    ).toBe(405);
    expect(
      (await handleOperator(post("no-such-entry", {}), deps(fakeEnv(calls))))
        .status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it("validates the locator against the bucket roster and the entry's targets, and the body against the schema", async () => {
    const calls: Call[] = [];
    const d = deps(fakeEnv(calls));
    for (const [entry, body] of [
      ["read-schema-version", { locator: "dir:g1:b16" }],
      ["read-schema-version", { locator: "dir:g9:b0" }],
      ["read-schema-version", { locator: "not-a-locator" }],
      ["list-bucket-user-ids", { locator: USER }],
      ["purge-user-mappings", { locator: "dir:g1:b0", userId: "nope" }],
      ["requeue-poisoned-job", { locator: USER }],
      [
        "list-quarantined-events",
        { locator: USER, cursor: { completedAt: -1, eventId: "e" } },
      ],
    ] as const) {
      const response = await handleOperator(post(entry, body), d);
      expect(response.status, `${entry} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("routes every entry to the right class and method, and answers the envelope's value", async () => {
    const calls: Call[] = [];
    const entries: Entry[] = [];
    const d = deps(fakeEnv(calls), entries);
    const cases: [string, Record<string, unknown>, string, string][] = [
      [
        "read-schema-version",
        { locator: "dir:g1:b3" },
        "dir:dir:g1:b3",
        "readSchemaVersion",
      ],
      [
        "read-schema-version",
        { locator: USER },
        `user:${USER}`,
        "readSchemaVersion",
      ],
      [
        "list-bucket-user-ids",
        { locator: "dir:g1:b0" },
        "dir:dir:g1:b0",
        "listBucketUserIds",
      ],
      [
        "read-delivery-backlog",
        { locator: USER },
        `user:${USER}`,
        "readDeliveryBacklog",
      ],
      [
        "list-quarantined-events",
        { locator: USER },
        `user:${USER}`,
        "listQuarantinedEvents",
      ],
      [
        "requeue-quarantined-event",
        { locator: USER, eventId: "evt-1" },
        `user:${USER}`,
        "requeueQuarantinedEvent",
      ],
      [
        "delete-quarantined-event",
        { locator: USER, eventId: "evt-1" },
        `user:${USER}`,
        "deleteQuarantinedEvent",
      ],
      [
        "list-poisoned-jobs",
        { locator: "dir:g1:b0", cursor: null },
        "dir:dir:g1:b0",
        "listPoisonedJobs",
      ],
      [
        "requeue-poisoned-job",
        { locator: USER, operationKey: "resume-link:op" },
        `user:${USER}`,
        "requeuePoisonedJob",
      ],
      [
        "delete-poisoned-job",
        { locator: "dir:g1:b1", operationKey: "k" },
        "dir:dir:g1:b1",
        "deletePoisonedJob",
      ],
      [
        "purge-user-mappings",
        { locator: "dir:g1:b0", userId: USER },
        "dir:dir:g1:b0",
        "purgeUserMappings",
      ],
    ];
    expect(Object.keys(OPERATOR_ENTRIES).sort()).toEqual(
      cases
        .map((c) => c[0])
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort(),
    );
    for (const [entry, body, target, method] of cases) {
      calls.length = 0;
      const response = await handleOperator(post(entry, body), d);
      expect(response.status, entry).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        result: { fine: true },
      });
      expect(calls.map((c) => `${c.name}#${c.method}`)).toEqual([
        `${target}#${method}`,
      ]);
    }
    const requeue = calls.length;
    void requeue;
    const audit = entries
      .filter((e) => e.message === "operator")
      .map((e) => e.meta);
    expect(audit).toHaveLength(cases.length);
    expect(audit[5]).toEqual({
      entry: "requeue-quarantined-event",
      locator: USER,
      id: "evt-1",
      outcome: "ok",
    });
    expect(audit[0]).toEqual({
      entry: "read-schema-version",
      locator: "dir:g1:b3",
      outcome: "ok",
    });
    expect(JSON.stringify(entries)).not.toContain("fine");
  });

  it("answers a Durable Object's error verbatim with its status, and audits the outcome", async () => {
    const calls: Call[] = [];
    const entries: Entry[] = [];
    const d = deps(
      fakeEnv(calls, () => ({
        ok: false,
        error: {
          kind: "system",
          code: "SCHEMA_VERSION_AHEAD",
          message: "ahead",
          retryable: false,
        },
      })),
      entries,
    );
    const response = await handleOperator(
      post("list-poisoned-jobs", { locator: USER }),
      d,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: "system", code: "SCHEMA_VERSION_AHEAD" },
    });
    expect(entries[0]?.meta).toEqual({
      entry: "list-poisoned-jobs",
      locator: USER,
      outcome: "SCHEMA_VERSION_AHEAD",
    });
  });
});
