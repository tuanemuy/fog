import type { Client, Transaction } from "@libsql/client/web";
import { createCloudflareResetMailer } from "@repo/core/adapters/fog/cloudflareEmailMailer";
import { LibsqlFogUnitOfWork } from "@repo/core/adapters/fog/unitOfWork";
import { createRemoteLibsqlClient } from "@repo/core/adapters/libsql/client.web";
import { readCloudflareServerEnv } from "@repo/core/application/di/serverCloudflare";
import type {
  FogUnitOfWork,
  FogUnitOfWorkProvider,
} from "@repo/core/application/fog/ports";
import type { FogServices } from "@repo/core/application/fog/types";
import type { Logger } from "@repo/core/application/ports/logger";
import { expect, it, vi } from "vitest";
import { createFogHttpHandler } from "@/serverHttp";
import {
  RESET_MAIL_CRON,
  RETENTION_CRON,
  runFogScheduled,
} from "./fogScheduled";

it("serves health checks and preserves the common routing contract in workerd", async () => {
  const render = vi.fn(async () => new Response("rendered"));
  const handler = createFogHttpHandler({
    appUrl: "https://fog.example.com",
    services: {} as FogServices,
    logger: console as Logger,
    healthCheck: vi.fn(async () => {}),
    healthDetails: {
      deploymentSha: "a".repeat(40),
      deploymentEnv: "production",
      databaseIdentity: "fog-production.example.com",
    },
    render,
  });
  const response = await handler(
    new Request("https://fog.example.com/healthz"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    deploymentSha: "a".repeat(40),
    deploymentEnv: "production",
    databaseIdentity: "fog-production.example.com",
  });
  expect(render).not.toHaveBeenCalled();
  expect(
    (
      await handler(
        new Request("https://fog.example.com/healthz", { method: "POST" }),
      )
    ).status,
  ).toBe(405);
});

it("routes both configured cron expressions through their bounded workers", async () => {
  const resetCleanup = vi.fn(async () => {});
  const retentionOwners = vi.fn(async () => []);
  const context = {
    account: { deleteExpiredResetMail: resetCleanup },
    retentionOwners,
  } as unknown as FogUnitOfWork;
  const unitOfWork: FogUnitOfWorkProvider = {
    run: (operation) => operation(context),
    read: (operation) => operation(context),
  };
  const deps = {
    unitOfWork,
    clock: { now: () => new Date("2026-09-06T03:00:00.000Z") },
    ids: { next: () => "0199-0000", validate: () => true },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  await runFogScheduled(RESET_MAIL_CRON, deps);
  await runFogScheduled(RETENTION_CRON, deps);
  expect(resetCleanup).toHaveBeenCalledOnce();
  expect(retentionOwners).toHaveBeenCalledWith({ limit: 25 });
});

it("accepts only authenticated TLS remote database URLs", () => {
  const validRuntimeEnv = {
    DATABASE_URL: "libsql://fog-production.example.com",
    DATABASE_AUTH_TOKEN: "token",
    APP_URL: "https://fog.example.com",
    DEPLOYMENT_SHA: "a".repeat(40),
    DEPLOYMENT_ENV: "production",
    EXPECTED_DATABASE_IDENTITY: "fog-production.example.com",
    FOG_GOOGLE_CALLBACK_URL: "https://fog.example.com/auth/google/callback",
    FOG_GOOGLE_CLIENT_ID: "google-id",
    FOG_GOOGLE_CLIENT_SECRET: "google-secret",
    FOG_EMAIL_FROM: "fog@example.com",
  } as const;
  for (const url of [
    ":memory:",
    "file:./fog.db",
    "http://database.example.com",
    "ws://database.example.com",
    "libsql://database.example.com?tls=0",
    "libsql://database.example.com?tls=1&tls=0",
    "libsql://database.example.com?tls=false",
    "libsql://database.example.com?TLS=1",
    "libsql://database.example.com?mode=readonly",
    "libsql://user:secret@database.example.com",
    "https://database.example.com?authToken=secret",
    "https://database.example.com#fragment",
  ])
    expect(() => createRemoteLibsqlClient({ url, authToken: "token" })).toThrow(
      /secure remote libSQL|credentials|requires TLS/,
    );
  expect(() =>
    createRemoteLibsqlClient({
      url: "https://database.example.com",
      authToken: "  ",
    }),
  ).toThrow("DATABASE_AUTH_TOKEN");
  for (const url of [
    "libsql://database.example.com",
    "libsql://database.example.com?tls=1",
    "https://database.example.com",
    "wss://database.example.com",
  ]) {
    const client = createRemoteLibsqlClient({ url, authToken: " token " });
    client.close();
  }
  expect(
    readCloudflareServerEnv({
      ...validRuntimeEnv,
      DATABASE_URL: " libsql://fog-production.example.com ",
      DATABASE_AUTH_TOKEN: " token ",
    }),
  ).toMatchObject({
    DATABASE_URL: "libsql://fog-production.example.com",
    DATABASE_AUTH_TOKEN: "token",
  });
  expect(() =>
    readCloudflareServerEnv({
      ...validRuntimeEnv,
      DATABASE_URL: "http://database.example.com",
    }),
  ).toThrow();
  expect(() =>
    readCloudflareServerEnv({
      ...validRuntimeEnv,
      DATABASE_AUTH_TOKEN: "   ",
    }),
  ).toThrow();
  expect(() =>
    readCloudflareServerEnv({
      ...validRuntimeEnv,
      DATABASE_URL: "https://staging-database.example.com",
    }),
  ).toThrow("selected stage database");
  expect(() =>
    readCloudflareServerEnv({
      ...validRuntimeEnv,
      APP_URL: "https://staging-fog.example.com",
    }),
  ).toThrow(/APP_URL|callback/);
  for (const missing of [
    "FOG_GOOGLE_CLIENT_ID",
    "FOG_GOOGLE_CLIENT_SECRET",
  ] as const)
    expect(() =>
      readCloudflareServerEnv({ ...validRuntimeEnv, [missing]: undefined }),
    ).toThrow();
  for (const sender of ["fog-staging@example.com", "fog@external.example"])
    expect(() =>
      readCloudflareServerEnv({ ...validRuntimeEnv, FOG_EMAIL_FROM: sender }),
    ).toThrow("FOG_EMAIL_FROM");
});

it("drives mocked remote interactive read/write transactions in workerd", async () => {
  const modes: string[] = [];
  const commits: string[] = [];
  const client = {
    transaction: async (mode: "read" | "write") => {
      modes.push(mode);
      let closed = false;
      return {
        get closed() {
          return closed;
        },
        commit: async () => {
          commits.push(mode);
          closed = true;
        },
        rollback: async () => {
          closed = true;
        },
        close: () => {
          closed = true;
        },
      } as unknown as Transaction;
    },
  } as unknown as Client;
  const unitOfWork = new LibsqlFogUnitOfWork(client);
  await expect(unitOfWork.read(async () => "read-result")).resolves.toBe(
    "read-result",
  );
  await expect(unitOfWork.run(async () => "write-result")).resolves.toBe(
    "write-result",
  );
  expect(modes).toEqual(["read", "write"]);
  expect(commits).toEqual(["read", "write"]);
});

it("sends reset mail to the requested recipient with the stable outbox ID", async () => {
  const send = vi.fn(async () => ({ messageId: "provider-id" }));
  const mailer = createCloudflareResetMailer({
    binding: { send },
    from: "reset@fog.example.com",
  });
  await mailer.sendPasswordReset({
    id: "outbox-id",
    to: "arbitrary-recipient@example.net",
    resetUrl: "https://fog.example.com/password.reset?token=secret",
    expiresAt: "2026-09-06T04:00:00.000Z",
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "arbitrary-recipient@example.net",
      headers: { "X-Fog-Message-ID": "outbox-id" },
    }),
  );
});
