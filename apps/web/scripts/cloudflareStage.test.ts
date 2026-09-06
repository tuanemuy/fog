import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyCloudflareAuthority } from "./cloudflareAuthority.node";
import { runCloudflareBuild } from "./cloudflareBuild.node";
import { type ChildCommand, runChildCommand } from "./cloudflareChild.node";
import { renderConfig, stageConfigPath } from "./cloudflareConfig.node";
import { runCloudflareDeploy } from "./cloudflareDeploy.node";
import {
  assertSafeWorkspacePath,
  atomicWriteSafeFile,
  buildRoot,
  webRoot,
} from "./cloudflareFilesystem.node";
import {
  type CloudflarePreflight,
  createCloudflarePreflight,
} from "./cloudflarePreflight.node";
import {
  type ArtifactProvenance,
  artifactTreeDigest,
  assertArtifactProvenance,
  builtConfigPath,
} from "./cloudflareProvenance.node";
import { syncRuntimeSecrets } from "./cloudflareSecrets.node";
import {
  deploymentDomain,
  renderStageConfig,
  runtimeSecrets,
  type StageConfig,
  validateBuiltStageConfig,
  validateStageConfig,
  validateStagePair,
} from "./cloudflareStage";
import { runCloudflareMigration } from "./migrate.cloudflare.node";

const template = {
  $schema: "../../../node_modules/wrangler/config-schema.json",
  name: "__WORKER_NAME__",
  main: "../../../app/server.cloudflare.ts",
  compatibility_date: "2026-08-04",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  routes: [{ pattern: "__HOSTNAME__", custom_domain: true }],
  triggers: { crons: ["* * * * *", "0 3 * * *"] },
  send_email: [{ name: "EMAIL", allowed_sender_addresses: ["__EMAIL_FROM__"] }],
  secrets: {
    required: [
      "DATABASE_URL",
      "DATABASE_AUTH_TOKEN",
      "FOG_GOOGLE_CLIENT_ID",
      "FOG_GOOGLE_CLIENT_SECRET",
    ],
  },
  vars: {
    APP_URL: "__APP_URL__",
    DEPLOYMENT_SHA: "__DEPLOYMENT_SHA__",
    DEPLOYMENT_ENV: "__STAGE__",
    EXPECTED_DATABASE_IDENTITY: "__DATABASE_IDENTITY__",
    FOG_EMAIL_FROM: "__EMAIL_FROM__",
    FOG_GOOGLE_CALLBACK_URL: "__GOOGLE_CALLBACK_URL__",
  },
};

const stagingDatabaseIdentity = "fog-staging.example.turso.io";
const deploymentSha = "a".repeat(40);
const stagingDatabaseUrl = `libsql://${stagingDatabaseIdentity}`;
const productionDatabaseIdentity = "fog-production.example.turso.io";
const productionDatabaseUrl = `libsql://${productionDatabaseIdentity}`;
const sourcePath = stageConfigPath("staging");
const artifactPath = builtConfigPath;
const provenance: ArtifactProvenance = {
  version: 2,
  stage: "staging",
  gitSha: "0".repeat(40),
  gitClean: true,
  workspaceDigest: "0".repeat(64),
  sourceConfigDigest: "0".repeat(64),
  builtConfigDigest: "0".repeat(64),
  builtEntryDigest: "0".repeat(64),
  serverDigest: "0".repeat(64),
  clientDigest: "0".repeat(64),
};

const stageConfig = () =>
  renderStageConfig({
    template,
    stage: "staging",
    domain: "example.com",
    databaseIdentity: stagingDatabaseIdentity,
    databaseUrl: stagingDatabaseUrl,
    deploymentSha,
  });
const productionConfig = () =>
  renderStageConfig({
    template,
    stage: "production",
    domain: "example.com",
    databaseIdentity: productionDatabaseIdentity,
    databaseUrl: productionDatabaseUrl,
    deploymentSha,
  });

function builtConfig(config: StageConfig): Record<string, unknown> {
  return {
    configPath: sourcePath,
    userConfigPath: sourcePath,
    topLevelName: config.name,
    definedEnvironments: [],
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    name: config.name,
    main: "index.js",
    routes: config.routes,
    triggers: config.triggers,
    assets: { directory: "../client" },
    workers_dev: config.workers_dev,
    vars: config.vars,
    secrets: config.secrets,
    durable_objects: { bindings: [] },
    workflows: [],
    migrations: [],
    exports: {},
    kv_namespaces: [],
    cloudchamber: {},
    send_email: config.send_email,
    queues: { producers: [], consumers: [] },
    connect: [],
    r2_buckets: [],
    d1_databases: [],
    vectorize: [],
    ai_search_namespaces: [],
    ai_search: [],
    agent_memory: [],
    hyperdrive: [],
    services: [],
    analytics_engine_datasets: [],
    dispatch_namespaces: [],
    mtls_certificates: [],
    pipelines: [],
    secrets_store_secrets: [],
    artifacts: [],
    unsafe_hello_world: [],
    flagship: [],
    worker_loaders: [],
    ratelimits: [],
    vpc_services: [],
    vpc_networks: [],
    logfwdr: { bindings: [] },
    python_modules: { exclude: ["**/*.pyc"] },
    dev: {
      ip: "localhost",
      local_protocol: "http",
      upstream_protocol: "http",
      enable_containers: true,
      generate_types: false,
    },
    no_bundle: true,
  };
}

const requiredSource = {
  DATABASE_IDENTITY: stagingDatabaseIdentity,
  DATABASE_URL: ` ${stagingDatabaseUrl} `,
  DATABASE_AUTH_TOKEN: " database-token ",
  FOG_GOOGLE_CLIENT_ID: " google-id ",
  FOG_GOOGLE_CLIENT_SECRET: " google-secret ",
  CLOUDFLARE_API_TOKEN: "cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
};

async function preflight(
  source: Readonly<Record<string, string | undefined>> = requiredSource,
  config: StageConfig = stageConfig(),
  built: unknown = builtConfig(config),
): Promise<CloudflarePreflight> {
  return createCloudflarePreflight({
    stage: "staging",
    sourceConfig: config,
    sourceConfigPath: sourcePath,
    builtConfig: built,
    builtConfigPath: artifactPath,
    source,
    sideEffect: true,
    provenanceVerifier: async () => provenance,
  });
}

describe("Cloudflare exact stage configuration", () => {
  it("renders deterministic isolated staging and production configs", () => {
    const staging = stageConfig();
    const production = productionConfig();
    expect(staging).toMatchObject({
      name: "fog-staging",
      main: "../../../app/server.cloudflare.ts",
      compatibility_date: "2026-08-04",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      routes: [{ pattern: "staging-fog.example.com", custom_domain: true }],
      triggers: { crons: ["* * * * *", "0 3 * * *"] },
      send_email: [
        {
          name: "EMAIL",
          allowed_sender_addresses: ["fog-staging@example.com"],
        },
      ],
      vars: {
        APP_URL: "https://staging-fog.example.com",
        DEPLOYMENT_SHA: deploymentSha,
        DEPLOYMENT_ENV: "staging",
        EXPECTED_DATABASE_IDENTITY: stagingDatabaseIdentity,
        FOG_EMAIL_FROM: "fog-staging@example.com",
        FOG_GOOGLE_CALLBACK_URL:
          "https://staging-fog.example.com/auth/google/callback",
      },
    });
    validateStagePair(staging, production);
    expect(JSON.stringify([staging, production])).not.toContain("libsql://");
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "com",
    "co.uk",
    "foo.example.com",
    "$" + "{DOMAIN}",
    "__DOMAIN__",
    "https://example.com",
    "example.com/path",
  ])("rejects unsafe or non-apex DOMAIN %s", (domain) => {
    expect(() => deploymentDomain(domain)).toThrow();
  });

  it("requires an independent stage-named database authority", () => {
    expect(() =>
      renderStageConfig({
        template,
        stage: "staging",
        domain: "example.com",
        databaseIdentity: productionDatabaseIdentity,
        databaseUrl: productionDatabaseUrl,
        deploymentSha,
      }),
    ).toThrow("fog-staging");
    expect(() =>
      renderStageConfig({
        template,
        stage: "staging",
        domain: "example.com",
        databaseIdentity: stagingDatabaseIdentity,
        databaseUrl: productionDatabaseUrl,
        deploymentSha,
      }),
    ).toThrow("authority");
  });

  it("rejects source and pair drift exactly", () => {
    const staging = stageConfig();
    expect(() =>
      validateStageConfig(
        {
          ...staging,
          compatibility_flags: ["nodejs_compat", "streams_enable_constructors"],
        },
        "staging",
      ),
    ).toThrow();
    expect(() =>
      validateStageConfig(
        { ...staging, compatibility_flags: ["nodejs_compat", "nodejs_compat"] },
        "staging",
      ),
    ).toThrow();
    expect(() =>
      validateStagePair(staging, {
        ...productionConfig(),
        vars: {
          ...productionConfig().vars,
          EXPECTED_DATABASE_IDENTITY: stagingDatabaseIdentity,
        },
      }),
    ).toThrow();
  });

  it.each([
    ["compatibility_date", "2026-08-03"],
    ["compatibility_flags", []],
    ["compatibility_flags", ["nodejs_compat", "extra"]],
    ["workers_dev", true],
    ["main", "server.node.js"],
  ])("rejects built config drift in %s", (key, value) => {
    const config = stageConfig();
    expect(() =>
      validateBuiltStageConfig(
        { ...builtConfig(config), [key]: value },
        config,
      ),
    ).toThrow();
  });

  it("rejects unknown built fields and bindings", () => {
    const config = stageConfig();
    expect(() =>
      validateBuiltStageConfig(
        { ...builtConfig(config), unknown: true },
        config,
      ),
    ).toThrow("unknown");
    expect(() =>
      validateBuiltStageConfig(
        { ...builtConfig(config), d1_databases: [{ binding: "DB" }] },
        config,
      ),
    ).toThrow("unexpected binding");
  });
});

describe("Cloudflare shared side-effect preflight", () => {
  it("rejects stale source, config, entry, module tree, SHA, and dirty deploy provenance", () => {
    const actual = {
      stage: provenance.stage,
      gitSha: provenance.gitSha,
      workspaceDigest: provenance.workspaceDigest,
      sourceConfigDigest: provenance.sourceConfigDigest,
      builtConfigDigest: provenance.builtConfigDigest,
      builtEntryDigest: provenance.builtEntryDigest,
      serverDigest: provenance.serverDigest,
      clientDigest: provenance.clientDigest,
    };
    expect(assertArtifactProvenance(provenance, actual, true, true)).toEqual(
      provenance,
    );
    for (const key of Object.keys(actual) as (keyof typeof actual)[])
      expect(() =>
        assertArtifactProvenance(
          provenance,
          {
            ...actual,
            [key]:
              key === "stage" ? "production" : "f".repeat(actual[key].length),
          },
          false,
          false,
        ),
      ).toThrow(key);
    expect(() =>
      assertArtifactProvenance(
        { ...provenance, gitClean: false },
        actual,
        true,
        true,
      ),
    ).toThrow("clean checkout");
    expect(() =>
      assertArtifactProvenance(provenance, actual, true, false),
    ).toThrow("clean checkout");
  });

  it("validates and trims every secret with runtime-equivalent AI schema", () => {
    const ai = JSON.stringify([
      {
        id: "client",
        name: "Client",
        redirectUris: ["https://client.example/callback"],
      },
    ]);
    expect(
      runtimeSecrets(stageConfig(), { ...requiredSource, FOG_AI_CLIENTS: ai }),
    ).toMatchObject({ DATABASE_URL: stagingDatabaseUrl, FOG_AI_CLIENTS: ai });
    expect(runtimeSecrets(stageConfig(), requiredSource)).toEqual({
      DATABASE_URL: stagingDatabaseUrl,
      DATABASE_AUTH_TOKEN: "database-token",
      FOG_GOOGLE_CLIENT_ID: "google-id",
      FOG_GOOGLE_CLIENT_SECRET: "google-secret",
      FOG_AI_CLIENTS: null,
    });
    expect(() =>
      runtimeSecrets(stageConfig(), {
        ...requiredSource,
        FOG_AI_CLIENTS: "not-json",
      }),
    ).toThrow();
    expect(() =>
      runtimeSecrets(stageConfig(), {
        ...requiredSource,
        FOG_AI_CLIENTS: '[{"clientId":"wrong"}]',
      }),
    ).toThrow();
  });

  it.each([
    "DATABASE_IDENTITY",
    "DATABASE_URL",
    "DATABASE_AUTH_TOKEN",
    "FOG_GOOGLE_CLIENT_ID",
    "FOG_GOOGLE_CLIENT_SECRET",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ])("rejects missing %s before a side effect token exists", async (key) => {
    await expect(preflight({ ...requiredSource, [key]: " " })).rejects.toThrow(
      key,
    );
  });

  it("rejects DB authority, AI, and built provenance inputs before operations", async () => {
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY: productionDatabaseIdentity,
      }),
    ).rejects.toThrow("fog-staging");
    await expect(
      preflight({ ...requiredSource, FOG_AI_CLIENTS: "[{}]" }),
    ).rejects.toThrow();
    await expect(
      preflight(requiredSource, stageConfig(), {
        ...builtConfig(stageConfig()),
        workers_dev: true,
      }),
    ).rejects.toThrow();
  });

  it("accepts only an explicit same-stage previous PITR authority", async () => {
    const previous = "fog-staging-before-pitr.example.turso.io";
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY_REBIND_FROM: ` ${previous} `,
      }),
    ).resolves.toMatchObject({ databaseIdentityRebindFrom: previous });
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY_REBIND_FROM: stagingDatabaseIdentity,
      }),
    ).rejects.toThrow("must differ");
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY_REBIND_FROM: productionDatabaseIdentity,
      }),
    ).rejects.toThrow("fog-staging");
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY_REBIND_FROM: `https://${previous}`,
      }),
    ).rejects.toThrow("normalized");
    await expect(
      preflight({
        ...requiredSource,
        DATABASE_IDENTITY_BOOTSTRAP: "true",
        DATABASE_IDENTITY_REBIND_FROM: previous,
      }),
    ).rejects.toThrow("cannot be used together");
  });
});

describe("Cloudflare read-only authority gate", () => {
  const accountId = "b".repeat(32);
  const token = "hostile-token-not-for-output";
  const auth = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };

  it("verifies the active token, exact account zone, and allows an absent initial Worker", async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(request));
        requests.push(url);
        expect(url.origin).toBe("https://api.cloudflare.com");
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${token}`,
        );
        if (url.pathname.endsWith("/user/tokens/verify"))
          return Response.json({ success: true, result: { status: "active" } });
        if (url.pathname.endsWith("/zones"))
          return Response.json({
            success: true,
            result: [
              {
                name: "example.com",
                status: "active",
                account: { id: accountId },
              },
            ],
          });
        return Response.json({ success: false }, { status: 404 });
      },
    );
    await expect(
      verifyCloudflareAuthority({
        stage: "staging",
        config: stageConfig(),
        auth,
        fetcher,
      }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests[1]?.searchParams.get("account.id")).toBe(accountId);
    expect(requests[1]?.searchParams.get("name")).toBe("example.com");
    expect(requests[2]?.pathname).toContain(
      `/accounts/${accountId}/workers/scripts/fog-staging/settings`,
    );
    expect(requests.every((url) => !url.href.includes(token))).toBe(true);
  });

  it("accepts an existing Worker only after a successful read response", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/user/tokens/verify"))
        return Response.json({ success: true, result: { status: "active" } });
      if (url.pathname.endsWith("/zones"))
        return Response.json({
          success: true,
          result: [
            {
              name: "example.com",
              status: "active",
              account: { id: accountId },
            },
          ],
        });
      return Response.json({ success: true, result: { bindings: [] } });
    });
    await expect(
      verifyCloudflareAuthority({
        stage: "staging",
        config: stageConfig(),
        auth,
        fetcher,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed Worker settings envelopes without exposing response bodies", async () => {
    const responseSecret = "worker-settings-response-secret";
    const invalidResponses: ReadonlyArray<readonly [string, () => Response]> = [
      ["missing result", () => Response.json({ success: true })],
      ["null result", () => Response.json({ success: true, result: null })],
      ["array result", () => Response.json({ success: true, result: [] })],
      ["string result", () => Response.json({ success: true, result: "bad" })],
      [
        "unsuccessful envelope",
        () =>
          Response.json({
            success: false,
            result: {},
            errors: [{ message: responseSecret }],
          }),
      ],
      [
        "malformed JSON",
        () =>
          new Response("{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ],
      [
        "hostile body",
        () =>
          new Response(responseSecret, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ],
    ];

    for (const [label, workerResponse] of invalidResponses) {
      const fetcher = vi.fn(async (request: RequestInfo | URL) => {
        const url = new URL(String(request));
        if (url.pathname.endsWith("/user/tokens/verify"))
          return Response.json({ success: true, result: { status: "active" } });
        if (url.pathname.endsWith("/zones"))
          return Response.json({
            success: true,
            result: [
              {
                name: "example.com",
                status: "active",
                account: { id: accountId },
              },
            ],
          });
        return workerResponse();
      });
      const result = verifyCloudflareAuthority({
        stage: "staging",
        config: stageConfig(),
        auth,
        fetcher,
      });
      await expect(result, label).rejects.toThrow("Worker verification");
      await result.catch((error: unknown) => {
        expect(String(error), label).not.toContain(responseSecret);
        expect(String(error), label).not.toContain(token);
      });
    }
  });

  it("fails closed without exposing hostile responses, transport errors, or tokens", async () => {
    const hostile = "response-secret-value";
    const inactive = vi.fn(async () =>
      Response.json({
        success: true,
        result: { status: hostile },
        extra: token,
      }),
    );
    const inactiveResult = verifyCloudflareAuthority({
      stage: "staging",
      config: stageConfig(),
      auth,
      fetcher: inactive,
    });
    await expect(inactiveResult).rejects.toThrow("token verification");
    await inactiveResult.catch((error: unknown) => {
      expect(String(error)).not.toContain(hostile);
      expect(String(error)).not.toContain(token);
    });

    const redirected = new Response("{}", { status: 200 });
    Object.defineProperty(redirected, "url", {
      value: "https://attacker.example/client/v4/zones",
    });
    const crossOrigin = vi.fn(async () => redirected);
    const crossOriginResult = verifyCloudflareAuthority({
      stage: "staging",
      config: stageConfig(),
      auth,
      fetcher: crossOrigin,
    });
    await expect(crossOriginResult).rejects.toThrow("token verification");

    const transport = vi.fn(async () => {
      throw new Error(`${hostile}:${token}`);
    });
    const transportResult = verifyCloudflareAuthority({
      stage: "staging",
      config: stageConfig(),
      auth,
      fetcher: transport,
    });
    await expect(transportResult).rejects.toThrow("token verification");
    await transportResult.catch((error: unknown) => {
      expect(String(error)).not.toContain(hostile);
      expect(String(error)).not.toContain(token);
    });
  });

  it("rejects a wrong account zone and a non-readable existing Worker", async () => {
    const zoneMismatch = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/user/tokens/verify"))
        return Response.json({ success: true, result: { status: "active" } });
      return Response.json({
        success: true,
        result: [
          {
            name: "example.com",
            status: "active",
            account: { id: "c".repeat(32) },
          },
        ],
      });
    });
    await expect(
      verifyCloudflareAuthority({
        stage: "staging",
        config: stageConfig(),
        auth,
        fetcher: zoneMismatch,
      }),
    ).rejects.toThrow("zone identity mismatch");

    const responseSecret = "worker-response-secret";
    const deniedWorker = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/user/tokens/verify"))
        return Response.json({ success: true, result: { status: "active" } });
      if (url.pathname.endsWith("/zones"))
        return Response.json({
          success: true,
          result: [
            {
              name: "example.com",
              status: "active",
              account: { id: accountId },
            },
          ],
        });
      return Response.json(
        { success: false, errors: [{ message: responseSecret }] },
        { status: 403 },
      );
    });
    const denied = verifyCloudflareAuthority({
      stage: "staging",
      config: stageConfig(),
      auth,
      fetcher: deniedWorker,
    });
    await expect(denied).rejects.toThrow("Worker verification");
    await denied.catch((error: unknown) => {
      expect(String(error)).not.toContain(responseSecret);
      expect(String(error)).not.toContain(token);
    });
  });

  it("times out and aborts without forwarding an abort reason", async () => {
    const fetcher = vi.fn(
      (_request: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(token)),
            { once: true },
          ),
        ),
    );
    const result = verifyCloudflareAuthority({
      stage: "staging",
      config: stageConfig(),
      auth,
      fetcher,
      requestTimeoutMs: 5,
    });
    await expect(result).rejects.toThrow("token verification");
    await result.catch((error: unknown) =>
      expect(String(error)).not.toContain(token),
    );
    await expect(
      verifyCloudflareAuthority({
        stage: "staging",
        config: stageConfig(),
        auth,
        fetcher,
        requestTimeoutMs: 0,
      }),
    ).rejects.toThrow("timeout");
    await expect(
      verifyCloudflareAuthority({
        stage: "staging",
        config: productionConfig(),
        auth,
        fetcher,
      }),
    ).rejects.toThrow("stage");
  });
});

describe("Cloudflare child process secret boundary", () => {
  it("puts hostile runtime values only in secret-bulk stdin", async () => {
    const invocations: ChildCommand[] = [];
    const hostileSource = {
      ...requiredSource,
      DATABASE_AUTH_TOKEN: " token\n$(echo nope);'\" ",
      FOG_GOOGLE_CLIENT_SECRET: " google\nsecret;$() ",
    };
    await syncRuntimeSecrets({
      preflight: await preflight(hostileSource),
      runner: async (input) => {
        invocations.push(input);
      },
    });
    const invocation = invocations[0];
    const serializedArgs = invocation?.args.join(" ") ?? "";
    for (const key of [
      "DATABASE_URL",
      "DATABASE_AUTH_TOKEN",
      "FOG_GOOGLE_CLIENT_ID",
      "FOG_GOOGLE_CLIENT_SECRET",
      "FOG_AI_CLIENTS",
    ])
      expect(invocation?.env[key]).toBeUndefined();
    expect(serializedArgs).not.toContain("echo nope");
    const stdin = invocation?.stdin;
    expect(
      JSON.parse(
        typeof stdin === "string"
          ? stdin
          : Buffer.from(stdin ?? []).toString("utf8") || "{}",
      ),
    ).toMatchObject({
      DATABASE_AUTH_TOKEN: "token\n$(echo nope);'\"",
      FOG_GOOGLE_CLIENT_SECRET: "google\nsecret;$()",
      FOG_AI_CLIENTS: null,
    });
    expect(invocation?.output).toEqual({
      mode: "discard",
      failureLabel: "Cloudflare secret synchronization",
    });
  });

  it("does not pass runtime secrets to deploy child env", async () => {
    const invocations: ChildCommand[] = [];
    await runCloudflareDeploy({
      preflight: await preflight(),
      dryRun: false,
      runner: async (input) => {
        invocations.push(input);
      },
    });
    expect(invocations[0]?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
    });
    expect(invocations[0]?.env.DATABASE_URL).toBeUndefined();
    expect(invocations[0]?.env.FOG_GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(invocations[0]?.output).toEqual({
      mode: "discard",
      failureLabel: "Cloudflare deployment",
    });
  });

  it("discards arbitrary sensitive child output on success and failure", async () => {
    const payload = JSON.stringify({
      multiline: "alpha\nbeta",
      prefix: "abc",
      extended: "abcdef",
      encoded: Buffer.from("https://secret.example/token").toString("base64"),
    });
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await runChildCommand({
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data',d=>{process.stdout.write(d);process.stderr.write(Buffer.concat([Buffer.from([0,255]),d]))})",
        ],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
        stdin: payload,
        output: { mode: "discard", failureLabel: "Sensitive fixture" },
      });
      const failed = runChildCommand({
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data',d=>{process.stdout.write(d);process.stderr.write(d)});process.stdin.on('end',()=>process.exit(9))",
        ],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
        stdin: payload,
        output: { mode: "discard", failureLabel: "Sensitive fixture" },
      });
      await expect(failed).rejects.toThrow(
        "Sensitive fixture failed with exit 9",
      );
      await failed.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("alpha");
        expect(message).not.toContain("beta");
        expect(message).not.toContain("def");
        expect(message).not.toContain("secret");
      });
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("keeps sensitive EPIPE and abort errors secret-independent", async () => {
    const secret = "prefix\nhttps://secret.example/";
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const closed = runChildCommand({
        command: process.execPath,
        args: ["-e", "process.stdin.destroy(); process.exit(0)"],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
        stdin: secret.repeat(200_000),
        output: { mode: "discard", failureLabel: "Sensitive fixture" },
      });
      await expect(closed).rejects.toThrow(
        "Sensitive fixture failed with exit 0",
      );
      await closed.catch((error: unknown) =>
        expect(String(error)).not.toContain(secret),
      );
      const controller = new AbortController();
      const aborted = runChildCommand({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)});setInterval(()=>{},1000)`,
        ],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
        signal: controller.signal,
        output: { mode: "discard", failureLabel: "Sensitive fixture" },
      });
      setTimeout(() => controller.abort(new Error(secret)), 25);
      await expect(aborted).rejects.toThrow(
        "Sensitive fixture failed with signal",
      );
      await aborted.catch((error: unknown) =>
        expect(String(error)).not.toContain(secret),
      );
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("Cloudflare database marker and migration transaction", () => {
  it("bootstraps an explicit marker and migrates idempotently", async () => {
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "db-test-"),
    );
    const client = createClient({
      url: `file:${path.join(sandbox, "idempotent.db")}`,
    });
    const wrapper = {
      execute: client.execute.bind(client),
      batch: client.batch.bind(client),
      transaction: client.transaction.bind(client),
      close: vi.fn(),
    };
    await runCloudflareMigration({
      preflight: await preflight({
        ...requiredSource,
        DATABASE_IDENTITY_BOOTSTRAP: "true",
      }),
      createClient: () => wrapper,
    });
    await runCloudflareMigration({
      preflight: await preflight(),
      createClient: () => wrapper,
    });
    const marker = await client.execute(
      "SELECT stage,database_identity FROM fog_deployment_identity",
    );
    expect(marker.rows[0]).toMatchObject({
      stage: "staging",
      database_identity: stagingDatabaseIdentity,
    });
    expect(wrapper.close).toHaveBeenCalledTimes(2);
    client.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("rejects a wrong marker and an unauthorized token before migration", async () => {
    const migrate = vi.fn(async () => undefined);
    const client = createClient({ url: ":memory:" });
    await client.batch([
      "CREATE TABLE fog_deployment_identity(singleton INTEGER PRIMARY KEY,stage TEXT,database_identity TEXT)",
      "INSERT INTO fog_deployment_identity VALUES(1,'production','fog-production.example.turso.io')",
    ]);
    await expect(
      runCloudflareMigration({
        preflight: await preflight(),
        createClient: () => client,
        migrate,
      }),
    ).rejects.toThrow("marker");
    expect(migrate).not.toHaveBeenCalled();
    const unauthorized = {
      execute: vi.fn(async () => {
        throw new Error("UNAUTHORIZED");
      }),
      batch: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    await expect(
      runCloudflareMigration({
        preflight: await preflight(),
        createClient: () => unauthorized,
        migrate,
      }),
    ).rejects.toThrow("UNAUTHORIZED");
    expect(migrate).not.toHaveBeenCalled();
    expect(unauthorized.close).toHaveBeenCalledOnce();
    client.close();
  });

  it("rebinds an exact PITR marker atomically, rolls back, and converges", async () => {
    const previous = "fog-staging-before-pitr.example.turso.io";
    const unexpected = "fog-staging-unexpected.example.turso.io";
    const migrationPreflight = await preflight({
      ...requiredSource,
      DATABASE_IDENTITY_REBIND_FROM: previous,
    });
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "pitr-rebind-test-"),
    );
    const client = createClient({
      url: `file:${path.join(sandbox, "rebind.db")}`,
    });
    await client.batch([
      "CREATE TABLE fog_deployment_identity(singleton INTEGER PRIMARY KEY,stage TEXT,database_identity TEXT)",
      {
        sql: "INSERT INTO fog_deployment_identity VALUES(1,'staging',?)",
        args: [previous],
      },
    ]);
    const wrapper = {
      execute: client.execute.bind(client),
      batch: client.batch.bind(client),
      transaction: client.transaction.bind(client),
      close: vi.fn(),
    };
    await expect(
      runCloudflareMigration({
        preflight: migrationPreflight,
        createClient: () => wrapper,
        migrate: async (transaction) => {
          const marker = await transaction.execute(
            "SELECT database_identity FROM fog_deployment_identity WHERE singleton=1",
          );
          expect(marker.rows[0]?.database_identity).toBe(
            stagingDatabaseIdentity,
          );
          await transaction.execute("CREATE TABLE migration_probe(value TEXT)");
          throw new Error("failed after marker rebind");
        },
      }),
    ).rejects.toThrow("failed after marker rebind");
    let marker = await client.execute(
      "SELECT database_identity FROM fog_deployment_identity WHERE singleton=1",
    );
    expect(marker.rows[0]?.database_identity).toBe(previous);
    expect(
      await client.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_probe'",
      ),
    ).toMatchObject({ rows: [] });

    await expect(
      runCloudflareMigration({
        preflight: migrationPreflight,
        createClient: () => wrapper,
        migrate: async (transaction) => {
          await transaction.execute("CREATE TABLE migration_probe(value TEXT)");
        },
      }),
    ).resolves.toBeUndefined();
    marker = await client.execute(
      "SELECT database_identity FROM fog_deployment_identity WHERE singleton=1",
    );
    expect(marker.rows[0]?.database_identity).toBe(stagingDatabaseIdentity);
    await expect(
      runCloudflareMigration({
        preflight: migrationPreflight,
        createClient: () => wrapper,
        migrate: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    await client.execute({
      sql: "UPDATE fog_deployment_identity SET database_identity=? WHERE singleton=1",
      args: [unexpected],
    });
    const migrate = vi.fn(async () => undefined);
    await expect(
      runCloudflareMigration({
        preflight: migrationPreflight,
        createClient: () => wrapper,
        migrate,
      }),
    ).rejects.toThrow("marker");
    expect(migrate).not.toHaveBeenCalled();
    expect(wrapper.close).toHaveBeenCalledTimes(4);
    client.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("serializes long migrations independent of runner clock and converges", async () => {
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "db-test-"),
    );
    const databaseUrl = `file:${path.join(sandbox, "migration.db")}`;
    const bootstrap = createClient({ url: databaseUrl });
    await runCloudflareMigration({
      preflight: await preflight({
        ...requiredSource,
        DATABASE_IDENTITY_BOOTSTRAP: "true",
      }),
      createClient: () => bootstrap,
      migrate: async () => undefined,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = false;
    let overlap = false;
    const first = runCloudflareMigration({
      preflight: await preflight(),
      createClient: () => createClient({ url: databaseUrl }),
      migrate: async () => {
        active = true;
        entered();
        await held;
        active = false;
      },
    });
    await started;
    const clock = vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_999);
    const second = runCloudflareMigration({
      preflight: await preflight(),
      createClient: () => createClient({ url: databaseUrl }),
      migrate: async () => {
        if (active) overlap = true;
      },
    }).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);
    clock.mockRestore();
    expect(firstResult.status).toBe("fulfilled");
    expect(overlap).toBe(false);
    if (
      secondResult.status === "fulfilled" &&
      secondResult.value.status === "rejected"
    )
      await expect(
        runCloudflareMigration({
          preflight: await preflight(),
          createClient: () => createClient({ url: databaseUrl }),
          migrate: async () => undefined,
        }),
      ).resolves.toBeUndefined();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("rolls back a failed migration and recovers on the next process", async () => {
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "db-test-"),
    );
    const databaseUrl = `file:${path.join(sandbox, "recovery.db")}`;
    await expect(
      runCloudflareMigration({
        preflight: await preflight({
          ...requiredSource,
          DATABASE_IDENTITY_BOOTSTRAP: "true",
        }),
        createClient: () => createClient({ url: databaseUrl }),
        migrate: async (transaction) => {
          await transaction.execute("CREATE TABLE interrupted(value TEXT)");
          throw new Error("process interrupted");
        },
      }),
    ).rejects.toThrow("process interrupted");
    await expect(
      runCloudflareMigration({
        preflight: await preflight({
          ...requiredSource,
          DATABASE_IDENTITY_BOOTSTRAP: "true",
        }),
        createClient: () => createClient({ url: databaseUrl }),
        migrate: async (transaction) => {
          const interrupted = await transaction.execute(
            "SELECT 1 FROM sqlite_master WHERE name='interrupted'",
          );
          expect(interrupted.rows).toHaveLength(0);
        },
      }),
    ).resolves.toBeUndefined();
    await rm(sandbox, { recursive: true, force: true });
  });
});

describe("Cloudflare filesystem and cleanup", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((entry) => rm(entry, { recursive: true, force: true })),
    );
  });

  it("rejects traversal, symlink, and hardlink output paths", async () => {
    await expect(assertSafeWorkspacePath("/tmp/outside-fog")).rejects.toThrow(
      "inside",
    );
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "fs-test-"),
    );
    const outside = await mkdtemp("/tmp/fog-cloudflare-outside-");
    cleanup.push(sandbox, outside);
    const linkedDirectory = path.join(sandbox, "link");
    await symlink(outside, linkedDirectory);
    await expect(
      atomicWriteSafeFile(path.join(linkedDirectory, "config.json"), "{}"),
    ).rejects.toThrow("symbolic");
    const original = path.join(sandbox, "original.json");
    const hardlinked = path.join(sandbox, "hardlinked.json");
    await writeFile(original, "{}");
    await link(original, hardlinked);
    await expect(atomicWriteSafeFile(hardlinked, "{}")).rejects.toThrow(
      "hard linked",
    );
  });

  it("digests the complete client tree including favicon path, mode, and type", async () => {
    const sandbox = await mkdtemp(
      path.join(webRoot, ".cloudflare", "client-tree-test-"),
    );
    cleanup.push(sandbox);
    const client = path.join(sandbox, "client");
    const favicon = path.join(client, "favicon.svg");
    await mkdir(client);
    await writeFile(favicon, "<svg></svg>", { mode: 0o600 });
    const original = await artifactTreeDigest(client);
    await writeFile(favicon, "<svg><!-- changed --></svg>");
    expect(await artifactTreeDigest(client)).not.toBe(original);
    await writeFile(favicon, "<svg></svg>");
    expect(await artifactTreeDigest(client)).toBe(original);
    await chmod(favicon, 0o640);
    expect(await artifactTreeDigest(client)).not.toBe(original);
    await chmod(favicon, 0o600);
    const added = path.join(client, "added.txt");
    await writeFile(added, "added");
    expect(await artifactTreeDigest(client)).not.toBe(original);
    await rm(added);
    expect(await artifactTreeDigest(client)).toBe(original);
    const linked = path.join(client, "linked.svg");
    await symlink(favicon, linked);
    await expect(artifactTreeDigest(client)).rejects.toThrow("symbolic");
    await rm(linked);
    await link(favicon, linked);
    await expect(artifactTreeDigest(client)).rejects.toThrow("hard linked");
  });

  it("cleans .dev.vars and provenance after build failure", async () => {
    await renderConfig({
      stage: "staging",
      domain: "example.com",
      databaseIdentity: stagingDatabaseIdentity,
      databaseUrl: stagingDatabaseUrl,
      deploymentSha,
    });
    await expect(
      runCloudflareBuild({
        stage: "staging",
        configPath: stageConfigPath("staging"),
        source: process.env,
        runner: async () => {
          await mkdir(path.join(buildRoot, "server"), { recursive: true });
          await mkdir(path.join(webRoot, "node_modules", ".vite-rsc-temp"), {
            recursive: true,
          });
          await writeFile(
            path.join(buildRoot, "server", ".dev.vars"),
            "SECRET=x",
          );
          throw new Error("build failed");
        },
      }),
    ).rejects.toThrow("build failed");
    await expect(
      lstat(path.join(webRoot, "node_modules", ".vite-rsc-temp")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      assertSafeWorkspacePath(path.join(buildRoot, "server", ".dev.vars"), {
        requireFile: true,
      }),
    ).rejects.toThrow();
    await expect(
      assertSafeWorkspacePath(
        path.join(buildRoot, "server", "fog-provenance.json"),
        { requireFile: true },
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    const aborted = runCloudflareBuild({
      stage: "staging",
      configPath: stageConfigPath("staging"),
      source: process.env,
      signal: controller.signal,
      runner: async (command) => {
        await mkdir(path.join(buildRoot, "server"), { recursive: true });
        await writeFile(
          path.join(buildRoot, "server", ".dev.vars"),
          "SECRET=x",
        );
        await new Promise<void>((_resolve, reject) =>
          command.signal?.addEventListener(
            "abort",
            () => reject(command.signal?.reason),
            { once: true },
          ),
        );
      },
    });
    setTimeout(() => controller.abort(new Error("build abort")), 10);
    await expect(aborted).rejects.toThrow("build abort");
    await expect(
      assertSafeWorkspacePath(path.join(buildRoot, "server", ".dev.vars"), {
        requireFile: true,
      }),
    ).rejects.toThrow();
  });

  it("kills and waits for an aborted child without leaving a process", async () => {
    const controller = new AbortController();
    const operation = runChildCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: webRoot,
      env: { PATH: process.env.PATH },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test abort")), 25);
    await expect(operation).rejects.toThrow("test abort");
  });

  it("settles spawn and nonzero-exit failures", async () => {
    await expect(
      runChildCommand({
        command: path.join(webRoot, "missing-cloudflare-child"),
        args: [],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
      }),
    ).rejects.toThrow();
    await expect(
      runChildCommand({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
      }),
    ).rejects.toThrow("exit 7");
  });

  it("settles a closed child stdin without leaving a process", async () => {
    await expect(
      runChildCommand({
        command: process.execPath,
        args: ["-e", "process.stdin.destroy(); process.exit(0)"],
        cwd: webRoot,
        env: { PATH: process.env.PATH },
        stdin: "x".repeat(4 * 1024 * 1024),
      }),
    ).rejects.toThrow();
  });
});

beforeAll(async () => {
  await mkdir(path.join(webRoot, ".cloudflare"), { recursive: true });
});
