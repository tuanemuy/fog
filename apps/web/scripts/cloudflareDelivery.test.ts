import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { webRoot } from "./cloudflareFilesystem.node";
import {
  assertExpectedReleaseValidation,
  createStagingDeployment,
  type ReleaseValidation,
  setDeploymentStatus,
  validateReleaseCandidate,
} from "./cloudflareGithub.node";
import { waitForCloudflareHealth } from "./cloudflareSmoke.node";

const repositoryRoot = path.resolve(webRoot, "../..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/cloudflare-delivery.yml",
);
const sha = "a".repeat(40);
const runId = 321;

type WorkflowStep = {
  name: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type WorkflowJob = {
  name?: string;
  needs?: string;
  environment?: { name: string };
  concurrency?: { group: string; "cancel-in-progress": boolean };
  outputs?: Record<string, string>;
  env: Record<string, string>;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
};
type Workflow = {
  on: unknown;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

async function workflow(file = workflowPath): Promise<Workflow> {
  return parse(await readFile(file, "utf8")) as Workflow;
}

function actionUses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(actionUses);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === "uses" && typeof child === "string" ? [child] : []),
    ...actionUses(child),
  ]);
}

function steps(job: WorkflowJob): string[] {
  return job.steps.map((step) => step.name);
}

function productionRuns(input: {
  event: "push" | "workflow_dispatch" | "pull_request" | "tag";
  releaseJob: "success" | "failure" | "skipped";
  releaseCreated: boolean;
}): boolean {
  return (
    (input.event === "push" &&
      input.releaseJob === "success" &&
      input.releaseCreated) ||
    input.event === "workflow_dispatch"
  );
}

describe("Cloudflare delivery workflow contract", () => {
  it("pins every action and exposes only main push and guarded recovery triggers", async () => {
    const delivery = await workflow();
    const ci = await workflow(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
    );
    expect(delivery.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: {
        inputs: {
          release_tag: expect.objectContaining({
            required: true,
            type: "string",
          }),
          release_sha: expect.objectContaining({
            required: true,
            type: "string",
          }),
        },
      },
    });
    for (const use of [...actionUses(delivery), ...actionUses(ci)])
      expect(use).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    const expectedActions = new Set([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
      "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
    ]);
    for (const use of [...actionUses(delivery), ...actionUses(ci)])
      expect(expectedActions.has(use)).toBe(true);
    expect(JSON.stringify(delivery.on)).not.toMatch(/pull_request|tags/);
    expect(delivery.permissions).toEqual({});
  });

  it("configures a single root Node release component and matching initial version", async () => {
    const [config, manifest, rootPackage] = await Promise.all(
      [
        "release-please-config.json",
        ".release-please-manifest.json",
        "package.json",
      ].map(async (file) =>
        JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8")),
      ),
    );
    expect(config.packages).toEqual({
      ".": {
        component: "fog",
        "include-component-in-tag": false,
        "release-type": "node",
      },
    });
    expect(manifest).toEqual({ ".": rootPackage.version });
  });

  it("connects the Cloudflare authority command through both package boundaries", async () => {
    const [rootPackage, webPackage] = await Promise.all(
      [
        path.join(repositoryRoot, "package.json"),
        path.join(webRoot, "package.json"),
      ].map(async (file) => JSON.parse(await readFile(file, "utf8"))),
    );
    expect(rootPackage.scripts["cloudflare:authority"]).toBe(
      "pnpm --filter @repo/web cloudflare:authority",
    );
    expect(webPackage.scripts["cloudflare:authority"]).toBe(
      "tsx scripts/cloudflareAuthority.node.ts",
    );
  });

  it("documents every guarded deployment and recovery operation", async () => {
    const runbook = await readFile(
      path.join(repositoryRoot, "docs/runtime_cloudflare.md"),
      "utf8",
    );
    for (const required of [
      "can_approve_pull_request_reviews",
      "Contents、Pull requests、Issues",
      "DATABASE_IDENTITY_REBIND_FROM",
      "--ref main",
      "03:00 UTC",
      "最大 15 分",
      "HTTP 503",
      "Cache-Control: no-store",
      "最大 18 回",
      "request timeout 10 秒",
      "retry 間隔 5 秒",
      "body は secret または利用者データの露出を避けるためログへ出さない",
      "未登録を `null`",
      "sender domain",
      "DNS record",
      "read-only check は編集権限を完全には証明しない",
    ])
      expect(runbook).toContain(required);
  });

  it("orders immutable staging, release, public validation, and gated production", async () => {
    const jobs = (await workflow()).jobs;
    expect(jobs.staging).toMatchObject({
      name: "Deploy staging",
      needs: "verify",
      environment: { name: "staging" },
      concurrency: { group: "fog-staging", "cancel-in-progress": false },
    });
    const stagingSteps = steps(jobs.staging);
    expect(
      stagingSteps.indexOf("Verify staging Cloudflare authority"),
    ).toBeLessThan(stagingSteps.indexOf("Migrate staging database"));
    expect(stagingSteps.indexOf("Migrate staging database")).toBeLessThan(
      stagingSteps.indexOf("Synchronize staging runtime secrets"),
    );
    expect(
      stagingSteps.indexOf("Synchronize staging runtime secrets"),
    ).toBeLessThan(stagingSteps.indexOf("Deploy staging Worker"));
    expect(stagingSteps.indexOf("Deploy staging Worker")).toBeLessThan(
      stagingSteps.indexOf("Verify staging release and database readiness"),
    );
    expect(
      stagingSteps.indexOf("Verify staging release and database readiness"),
    ).toBeLessThan(stagingSteps.indexOf("Mark staging deployment successful"));
    expect(jobs.release.needs).toBe("staging");
    expect(jobs.release.outputs).toEqual({
      release_created: "$" + "{{ steps.normalize.outputs.release_created }}",
      tag_name: "$" + "{{ steps.normalize.outputs.tag_name }}",
      sha: "$" + "{{ steps.normalize.outputs.sha }}",
    });
    const releaseStep = jobs.release.steps.find(
      (step) => step.name === "Create or update release pull request",
    );
    expect(releaseStep?.with?.token).toBe(
      "$" + "{{ secrets.RELEASE_PLEASE_TOKEN || github.token }}",
    );
    expect(jobs.release.permissions).toEqual({
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
    expect(jobs["validate-production"].environment).toBeUndefined();
    expect(JSON.stringify(jobs["validate-production"])).not.toContain(
      "secrets.",
    );
    expect(jobs.production).toMatchObject({
      needs: "validate-production",
      environment: { name: "production" },
      concurrency: { group: "fog-production", "cancel-in-progress": false },
    });
    expect(jobs.production.steps[0].with?.ref).toBe(
      "$" + "{{ needs.validate-production.outputs.sha }}",
    );
    const productionSteps = steps(jobs.production);
    expect(
      productionSteps.indexOf("Verify production Cloudflare authority"),
    ).toBeLessThan(productionSteps.indexOf("Migrate production database"));
    expect(jobs["validate-production"].outputs).toEqual(
      expect.objectContaining({
        release_id: "$" + "{{ steps.validate.outputs.release_id }}",
        release_updated_at:
          "$" + "{{ steps.validate.outputs.release_updated_at }}",
        tag_object_sha: "$" + "{{ steps.validate.outputs.tag_object_sha }}",
        staging_deployment_id:
          "$" + "{{ steps.validate.outputs.staging_deployment_id }}",
        staging_status_id:
          "$" + "{{ steps.validate.outputs.staging_status_id }}",
        staging_run_id: "$" + "{{ steps.validate.outputs.staging_run_id }}",
        staging_run_attempt:
          "$" + "{{ steps.validate.outputs.staging_run_attempt }}",
      }),
    );
    const revalidate = jobs.production.steps.find(
      (step) => step.name === "Revalidate release after approval",
    );
    expect(revalidate?.env).toEqual(
      expect.objectContaining({
        EXPECTED_RELEASE_ID:
          "$" + "{{ needs.validate-production.outputs.release_id }}",
        EXPECTED_RELEASE_UPDATED_AT:
          "$" + "{{ needs.validate-production.outputs.release_updated_at }}",
        EXPECTED_TAG_OBJECT_SHA:
          "$" + "{{ needs.validate-production.outputs.tag_object_sha }}",
        EXPECTED_STAGING_DEPLOYMENT_ID:
          "$" + "{{ needs.validate-production.outputs.staging_deployment_id }}",
        EXPECTED_STAGING_STATUS_ID:
          "$" + "{{ needs.validate-production.outputs.staging_status_id }}",
        EXPECTED_STAGING_RUN_ID:
          "$" + "{{ needs.validate-production.outputs.staging_run_id }}",
        EXPECTED_STAGING_RUN_ATTEMPT:
          "$" + "{{ needs.validate-production.outputs.staging_run_attempt }}",
      }),
    );
    expect(steps(jobs.production)).toEqual(
      expect.arrayContaining([
        "Revalidate release after approval",
        "Verify production Cloudflare authority",
        "Migrate production database",
        "Synchronize production runtime secrets",
        "Deploy production Worker",
        "Verify production release and database readiness",
      ]),
    );
  });

  it("keeps environment contracts isolated and never interpolates dispatch input in shell", async () => {
    const jobs = (await workflow()).jobs;
    const environmentKeys = Object.keys(jobs.staging.env).sort();
    expect(Object.keys(jobs.production.env).sort()).toEqual(environmentKeys);
    expect(environmentKeys).toEqual(
      [
        "APP_URL",
        "DATABASE_IDENTITY",
        "DATABASE_IDENTITY_BOOTSTRAP",
        "DEPLOYMENT_ENV",
        "DEPLOYMENT_SHA",
        "DOMAIN",
      ].sort(),
    );
    const stagingMigration = jobs.staging.steps.find(
      (step) => step.name === "Migrate staging database",
    );
    const productionMigration = jobs.production.steps.find(
      (step) => step.name === "Migrate production database",
    );
    expect(Object.keys(stagingMigration?.env ?? {}).sort()).toEqual(
      [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
        "DATABASE_AUTH_TOKEN",
        "DATABASE_IDENTITY_REBIND_FROM",
        "DATABASE_URL",
        "FOG_AI_CLIENTS",
        "FOG_GOOGLE_CLIENT_ID",
        "FOG_GOOGLE_CLIENT_SECRET",
      ].sort(),
    );
    expect(productionMigration?.env).toEqual(stagingMigration?.env);
    for (const [job, stage] of [
      [jobs.staging, "staging"],
      [jobs.production, "production"],
    ] as const) {
      const authority = job.steps.find(
        (step) => step.name === `Verify ${stage} Cloudflare authority`,
      );
      expect(authority?.run).toBe(`pnpm cloudflare:authority --stage ${stage}`);
      expect(authority?.env).toEqual({
        CLOUDFLARE_API_TOKEN: "$" + "{{ secrets.CLOUDFLARE_API_TOKEN }}",
        CLOUDFLARE_ACCOUNT_ID: "$" + "{{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      });
      expect(JSON.stringify(authority)).not.toMatch(
        /DATABASE_URL|DATABASE_AUTH_TOKEN|FOG_GOOGLE/,
      );
    }
    for (const name of [
      "Install dependencies",
      "Build staging artifact and provenance",
    ])
      expect(
        jobs.staging.steps.find((step) => step.name === name)?.env,
      ).toBeUndefined();
    expect(jobs.staging.env.DEPLOYMENT_ENV).toBe("staging");
    expect(jobs.production.env.DEPLOYMENT_ENV).toBe("production");
    for (const job of Object.values(jobs))
      for (const step of job.steps)
        if (step.run) expect(step.run).not.toContain("$" + "{{ inputs.");
  });

  it.each([
    [{ event: "push", releaseJob: "success", releaseCreated: false }, false],
    [{ event: "push", releaseJob: "success", releaseCreated: true }, true],
    [{ event: "push", releaseJob: "failure", releaseCreated: true }, false],
    [
      {
        event: "workflow_dispatch",
        releaseJob: "skipped",
        releaseCreated: false,
      },
      true,
    ],
    [
      { event: "pull_request", releaseJob: "success", releaseCreated: true },
      false,
    ],
    [{ event: "tag", releaseJob: "success", releaseCreated: true }, false],
  ] as const)("simulates production gating %#", (input, expected) => {
    expect(productionRuns(input)).toBe(expected);
  });
});

function json(value: unknown, status = 200, link?: string): Response {
  return Response.json(value, {
    status,
    ...(link ? { headers: { Link: link } } : {}),
  });
}

const releaseUpdatedAt = "2026-09-06T00:00:00Z";
const createdAt = "2026-09-06T00:01:00Z";

function deployment(
  id = 99,
  date = createdAt,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    sha,
    environment: "staging",
    created_at: date,
    creator: { login: "github-actions[bot]", type: "Bot" },
    payload: {
      workflow_run_id: runId,
      workflow_run_attempt: 1,
      workflow_path: ".github/workflows/cloudflare-delivery.yml",
      sha,
    },
    ...overrides,
  };
}

function deploymentStatus(id = 199, date = createdAt, state = "success") {
  return { id, created_at: date, state };
}

function stagingJob(overrides: Record<string, unknown> = {}) {
  return {
    name: "Deploy staging",
    conclusion: "success",
    head_sha: sha,
    ...overrides,
  };
}

function pagedResponse(
  url: URL,
  pages: unknown[],
  links?: Array<string | null>,
): Response {
  const page = Number(url.searchParams.get("page") ?? "1");
  const value = pages[page - 1] ?? [];
  const configuredLink = links?.[page - 1];
  if (configuredLink !== undefined)
    return json(value, 200, configuredLink ?? undefined);
  if (page >= pages.length) return json(value);
  const next = new URL(url);
  next.searchParams.set("page", String(page + 1));
  return json(value, 200, `<${next.href}>; rel="next"`);
}

function releaseApi(overrides: Record<string, unknown> = {}): typeof fetch {
  const override = (key: string): Record<string, unknown> =>
    (overrides[key] ?? {}) as Record<string, unknown>;
  const pages = (key: string, fallback: unknown[]): unknown[] =>
    (overrides[key] ?? fallback) as unknown[];
  return vi.fn(async (request: RequestInfo | URL) => {
    const url = new URL(String(request));
    if (url.pathname.includes("/releases/tags/"))
      return json(
        {
          id: 10,
          tag_name: "v1.2.3",
          draft: false,
          prerelease: false,
          updated_at: releaseUpdatedAt,
          ...override("release"),
        },
        Number(overrides.releaseStatus ?? 200),
        overrides.releaseLink as string | undefined,
      );
    if (url.pathname.includes("/git/ref/tags/"))
      return json({
        object: { sha, type: "commit", ...override("tagObject") },
      });
    if (url.pathname.includes("/compare/"))
      return json({
        status: "ahead",
        merge_base_commit: { sha },
        ...override("compare"),
      });
    if (url.pathname.endsWith("/deployments"))
      return pagedResponse(
        url,
        pages("deploymentPages", [
          [deployment(99, createdAt, override("deployment"))],
        ]),
        overrides.deploymentLinks as Array<string | null> | undefined,
      );
    const statusMatch = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    if (statusMatch) {
      const byDeployment = (overrides.statusPagesByDeployment ?? {}) as Record<
        string,
        unknown[]
      >;
      return pagedResponse(
        url,
        byDeployment[statusMatch[1]] ??
          pages("statusPages", [
            [
              {
                ...deploymentStatus(),
                ...override("status"),
              },
            ],
          ]),
        overrides.statusLinks as Array<string | null> | undefined,
      );
    }
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname))
      return pagedResponse(
        url,
        pages("jobPages", [
          [
            {
              name: "Verify release candidate",
              conclusion: "success",
              head_sha: sha,
            },
            stagingJob(override("job")),
            {
              name: "Release Please",
              conclusion: "success",
              head_sha: sha,
            },
          ],
        ]).map((jobs) => ({ jobs })),
        overrides.jobLinks as Array<string | null> | undefined,
      );
    if (url.pathname.includes(`/actions/runs/${runId}`))
      return json({
        id: runId,
        run_attempt: 1,
        event: "push",
        head_sha: sha,
        head_branch: "main",
        path: ".github/workflows/cloudflare-delivery.yml@main",
        repository: { full_name: "owner/fog" },
        head_repository: { full_name: "owner/fog" },
        ...override("run"),
      });
    return json({}, 404);
  }) as typeof fetch;
}

const expectedValidation: ReleaseValidation = {
  tag: "v1.2.3",
  sha,
  releaseId: 10,
  releaseUpdatedAt,
  tagObjectSha: sha,
  stagingDeploymentId: 99,
  stagingStatusId: 199,
  stagingRunId: runId,
  stagingRunAttempt: 1,
};

async function validate(overrides: Record<string, unknown> = {}) {
  return validateReleaseCandidate({
    repository: "owner/fog",
    token: "token",
    tag: "v1.2.3",
    sha,
    fetcher: releaseApi(overrides),
  });
}

describe("release provenance", () => {
  it("accepts unrelated workflow jobs and uniquely selects Deploy staging", async () => {
    await expect(validate()).resolves.toEqual(expectedValidation);
  });

  it.each([
    ["draft release", { release: { draft: true } }],
    ["prerelease", { release: { prerelease: true } }],
    ["tag", { tagObject: { sha: "b".repeat(40) } }],
    [
      "main reachability",
      { compare: { merge_base_commit: { sha: "b".repeat(40) } } },
    ],
    [
      "deployment creator",
      { deployment: { creator: { login: "attacker", type: "User" } } },
    ],
    ["payload attempt", { deployment: { payload: {} } }],
    ["run event", { run: { event: "workflow_dispatch" } }],
    ["run path", { run: { path: ".github/workflows/attacker.yml@main" } }],
    ["run attempt", { run: { run_attempt: 2 } }],
    [
      "run repository",
      { run: { head_repository: { full_name: "attacker/fog" } } },
    ],
    ["staging job", { job: { conclusion: "failure" } }],
    ["staging job SHA", { job: { head_sha: "b".repeat(40) } }],
    ["deployment status", { status: { state: "failure" } }],
  ])("rejects hostile %s data", async (_name, overrides) => {
    await expect(validate(overrides)).rejects.toThrow();
  });

  it("rejects duplicate exact staging jobs while allowing other jobs", async () => {
    await expect(
      validate({ jobPages: [[stagingJob(), stagingJob()]] }),
    ).rejects.toThrow("one Deploy staging job");
  });

  it("uses only the newest deployment and does not fall back to an older success", async () => {
    const old = deployment(99, "2026-09-06T00:00:00Z");
    const current = deployment(100, "2026-09-06T00:02:00Z");
    await expect(
      validate({
        deploymentPages: [[old, current]],
        statusPagesByDeployment: {
          "99": [[deploymentStatus(199, createdAt, "success")]],
          "100": [[deploymentStatus(200, createdAt, "failure")]],
        },
      }),
    ).rejects.toThrow("not successful");
  });

  it("accepts the newest successful deployment without falling back to older state", async () => {
    await expect(
      validate({
        deploymentPages: [
          [
            deployment(99, "2026-09-06T00:00:00Z"),
            deployment(100, "2026-09-06T00:02:00Z"),
          ],
        ],
        statusPagesByDeployment: {
          "99": [[deploymentStatus(199, createdAt, "failure")]],
          "100": [[deploymentStatus(200, createdAt, "success")]],
        },
      }),
    ).resolves.toMatchObject({
      stagingDeploymentId: 100,
      stagingStatusId: 200,
    });
  });

  it("breaks equal deployment timestamps by the newest unique ID", async () => {
    await expect(
      validate({
        deploymentPages: [[deployment(99), deployment(100)]],
        statusPagesByDeployment: {
          "99": [[deploymentStatus(199, createdAt, "success")]],
          "100": [[deploymentStatus(200, createdAt, "inactive")]],
        },
      }),
    ).rejects.toThrow("not successful");
  });

  it("uses only the newest status and does not fall back to an older success", async () => {
    await expect(
      validate({
        statusPages: [
          [
            deploymentStatus(199, "2026-09-06T00:01:00Z", "success"),
            deploymentStatus(200, "2026-09-06T00:02:00Z", "inactive"),
          ],
        ],
      }),
    ).rejects.toThrow("not successful");
  });

  it("finds the authoritative deployment and job on page two", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      deployment(index + 1, "2026-09-05T00:00:00Z"),
    );
    const unrelatedJobs = Array.from({ length: 100 }, (_, index) => ({
      name: `Other job ${index}`,
      conclusion: "success",
      head_sha: sha,
    }));
    const oldStatuses = Array.from({ length: 100 }, (_, index) =>
      deploymentStatus(index + 1, "2026-09-05T00:00:00Z", "failure"),
    );
    await expect(
      validate({
        deploymentPages: [firstPage, [deployment(101, "2026-09-06T00:02:00Z")]],
        statusPages: [oldStatuses, [deploymentStatus(201)]],
        jobPages: [unrelatedJobs, [stagingJob()]],
      }),
    ).resolves.toMatchObject({
      stagingDeploymentId: 101,
      stagingStatusId: 201,
    });
  });

  it("rejects a newer failed deployment found on page two", async () => {
    await expect(
      validate({
        deploymentPages: [
          [deployment(99, "2026-09-06T00:01:00Z")],
          [deployment(100, "2026-09-06T00:02:00Z")],
        ],
        statusPagesByDeployment: {
          "99": [[deploymentStatus(199, createdAt, "success")]],
          "100": [[deploymentStatus(200, createdAt, "error")]],
        },
      }),
    ).rejects.toThrow("not successful");
  });

  it("rejects a newer failed status found on page two", async () => {
    await expect(
      validate({
        statusPages: [
          [deploymentStatus(199, "2026-09-06T00:01:00Z", "success")],
          [deploymentStatus(200, "2026-09-06T00:02:00Z", "failure")],
        ],
      }),
    ).rejects.toThrow("not successful");
  });

  it.each([
    [
      "cross-origin",
      ['<https://evil.example/repos/owner/fog/deployments?page=2>; rel="next"'],
    ],
    ["malformed", ["not-a-link"]],
    [
      "changed query",
      [
        `<https://api.github.com/repos/owner/fog/deployments?sha=${sha}&environment=production&per_page=100&page=2>; rel="next"`,
      ],
    ],
    [
      "duplicate next",
      [
        `<https://api.github.com/repos/owner/fog/deployments?sha=${sha}&environment=staging&per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/fog/deployments?sha=${sha}&environment=staging&per_page=100&page=3>; rel="next"`,
      ],
    ],
  ])("rejects %s pagination links", async (_name, deploymentLinks) => {
    await expect(
      validate({ deploymentPages: [[], []], deploymentLinks }),
    ).rejects.toThrow();
  });

  it("rejects pagination cycles, duplicate records, over-sized pages, and page-limit exhaustion", async () => {
    const pageTwo = `<https://api.github.com/repos/owner/fog/deployments?sha=${sha}&environment=staging&per_page=100&page=2>; rel="next"`;
    await expect(
      validate({
        deploymentPages: [[], []],
        deploymentLinks: [pageTwo, pageTwo],
      }),
    ).rejects.toThrow("cycle");
    await expect(
      validate({ deploymentPages: [[deployment(), deployment()]] }),
    ).rejects.toThrow("duplicate");
    await expect(
      validate({
        deploymentPages: [Array.from({ length: 101 }, () => deployment())],
      }),
    ).rejects.toThrow("exceeds");
    await expect(
      validate({ deploymentPages: Array.from({ length: 11 }, () => []) }),
    ).rejects.toThrow("page limit");
  });

  it("fails closed on API throttling without reflecting the response body", async () => {
    const fetcher = vi.fn(async () =>
      json({ secret: "credential-value" }, 429),
    ) as typeof fetch;
    const result = validateReleaseCandidate({
      repository: "owner/fog",
      token: "token",
      tag: "v1.2.3",
      sha,
      fetcher,
    });
    await expect(result).rejects.toThrow("status 429");
    await expect(result).rejects.not.toThrow("credential-value");
  });

  it("rejects pagination on singular release responses", async () => {
    await expect(
      validate({
        releaseLink:
          '<https://api.github.com/repos/owner/fog/releases/tags/v1.2.3?page=2>; rel="next"',
      }),
    ).rejects.toThrow("Unexpected pagination");
  });

  it.each([
    "owner/../fog",
    "../fog",
    "owner/%2e%2e",
    "owner/fog/extra",
    "owner./fog",
    "owner/fog.",
    "owner\\fog",
    "owner/fog\nattacker",
    "owner//fog",
  ])("rejects unsafe repository %s before any API request", async (repository) => {
    const fetcher = vi.fn() as typeof fetch;
    await expect(
      validateReleaseCandidate({
        repository,
        token: "token",
        tag: "v1.2.3",
        sha,
        fetcher,
      }),
    ).rejects.toThrow("Invalid repository");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("binds the post-approval validation to every public provenance output", () => {
    const expected = {
      EXPECTED_RELEASE_ID: "10",
      EXPECTED_RELEASE_UPDATED_AT: releaseUpdatedAt,
      EXPECTED_TAG_OBJECT_SHA: sha,
      EXPECTED_STAGING_DEPLOYMENT_ID: "99",
      EXPECTED_STAGING_STATUS_ID: "199",
      EXPECTED_STAGING_RUN_ID: String(runId),
      EXPECTED_STAGING_RUN_ATTEMPT: "1",
    };
    expect(() =>
      assertExpectedReleaseValidation(expectedValidation, expected),
    ).not.toThrow();
    expect(() =>
      assertExpectedReleaseValidation(
        { ...expectedValidation, stagingStatusId: 200 },
        expected,
      ),
    ).toThrow("changed after public validation");
    expect(() =>
      assertExpectedReleaseValidation(expectedValidation, {
        ...expected,
        EXPECTED_STAGING_STATUS_ID: undefined,
      }),
    ).toThrow("Expected release provenance is incomplete");
  });

  it("creates an immutable deployment payload and records only staging status", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(request), ...(init ? { init } : {}) });
        return json(calls.length === 1 ? { id: 99 } : { id: 100 });
      },
    ) as typeof fetch;
    await expect(
      createStagingDeployment({
        repository: "owner/fog",
        token: "token",
        sha,
        runId,
        runAttempt: 2,
        fetcher,
      }),
    ).resolves.toBe(99);
    await setDeploymentStatus({
      repository: "owner/fog",
      token: "token",
      deploymentId: 99,
      state: "success",
      environmentUrl: "https://staging-fog.example.com",
      fetcher,
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      ref: sha,
      environment: "staging",
      auto_merge: false,
      payload: {
        workflow_run_id: runId,
        workflow_run_attempt: 2,
        sha,
      },
    });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      state: "success",
      environment: "staging",
    });
  });
});

describe("release-aware health smoke", () => {
  const expected = {
    status: "ok" as const,
    deploymentSha: sha,
    deploymentEnv: "staging" as const,
    databaseIdentity: "fog-staging.example.turso.io",
  };

  it("retries until SHA, stage, and database readiness all match", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ ...expected, deploymentSha: "b".repeat(40) }),
      )
      .mockResolvedValueOnce(json(expected));
    await waitForCloudflareHealth({
      appUrl: "https://staging-fog.example.com",
      domain: "example.com",
      expected,
      attempts: 2,
      retryDelayMs: 0,
      fetcher,
      delay: async () => {},
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed without reflecting hostile response bodies", async () => {
    const fetcher = vi.fn(
      async () => new Response("DATABASE_AUTH_TOKEN=secret", { status: 503 }),
    );
    await expect(
      waitForCloudflareHealth({
        appUrl: "https://staging-fog.example.com",
        domain: "example.com",
        expected,
        attempts: 1,
        fetcher,
      }),
    ).rejects.toThrow("did not reach the expected release");
  });

  it.each([
    "https://staging-fog.example.com.evil.com",
    "https://x.staging-fog.example.com",
    "https://staging-fog.example.com.",
    "https://staging-fog.xn--xample-9ua.com",
    "https://staging-fog.example.com/",
    "https://STAGING-fog.example.com",
    "https://staging-fog.example.com:443",
    "https://user@staging-fog.example.com",
  ])("rejects a non-canonical smoke target %s before fetch", async (appUrl) => {
    const fetcher = vi.fn() as typeof fetch;
    await expect(
      waitForCloudflareHealth({
        appUrl,
        domain: "example.com",
        expected,
        attempts: 1,
        fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
