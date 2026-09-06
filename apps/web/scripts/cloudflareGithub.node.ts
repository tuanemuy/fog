import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { deploymentShaSchema } from "./cloudflareStage";

const apiOrigin = "https://api.github.com";
const apiVersion = "2026-03-10";
const pageSize = 100;
const maxPages = 10;
const ownerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
const repositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/);
const repositorySchema = z.string().transform((value, context) => {
  const parts = value.split("/");
  const owner = ownerSchema.safeParse(parts[0]);
  const name = repositoryNameSchema.safeParse(parts[1]);
  if (parts.length !== 2 || !owner.success || !name.success) {
    context.addIssue({ code: "custom", message: "Invalid repository" });
    return z.NEVER;
  }
  return { owner: owner.data, name: name.data, fullName: value };
});
const tagSchema = z
  .string()
  .regex(
    /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,
    "Invalid release tag",
  );
const idSchema = z.coerce.number().int().positive();
const timestampSchema = z.string().datetime({ offset: true });
const workflowPath = ".github/workflows/cloudflare-delivery.yml";
const workflowRunPathSchema = z.enum([
  workflowPath,
  `${workflowPath}@main`,
  `${workflowPath}@refs/heads/main`,
]);

type GithubFetch = typeof fetch;
type Repository = z.infer<typeof repositorySchema>;

function api(repository: Repository, suffix: string): string {
  const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const url = new URL(`${prefix}${suffix}`, apiOrigin);
  if (url.origin !== apiOrigin || !url.pathname.startsWith(`${prefix}/`))
    throw new Error("GitHub API URL escaped the selected repository");
  return url.href;
}

async function githubResponse(
  fetcher: GithubFetch,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<{ value: unknown; link: string | null }> {
  const response = await fetcher(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": apiVersion,
      ...init?.headers,
    },
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`GitHub API request failed with status ${response.status}`);
  return { value: await response.json(), link: response.headers.get("link") };
}

async function githubJson(
  fetcher: GithubFetch,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await githubResponse(fetcher, token, url, init);
  if (response.link)
    throw new Error("Unexpected pagination on a singular GitHub API response");
  return response.value;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  const links = header.split(/,(?=\s*<)/);
  const next: string[] = [];
  for (const link of links) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="([A-Za-z ]+)"\s*$/.exec(link);
    if (!match) throw new Error("GitHub pagination Link header is malformed");
    if (match[2].split(/\s+/).includes("next")) next.push(match[1]);
  }
  if (next.length > 1)
    throw new Error("GitHub pagination has multiple next links");
  return next[0];
}

function paginationUrl(value: string, initial: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub pagination URL is malformed");
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname !== initial.pathname
  )
    throw new Error("GitHub pagination URL escaped the selected endpoint");
  const allowed = new Set([...initial.searchParams.keys(), "page"]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error("GitHub pagination query is invalid");
  for (const [key, expected] of initial.searchParams)
    if (key !== "page" && url.searchParams.get(key) !== expected)
      throw new Error("GitHub pagination query changed the selected resource");
  if (!/^[1-9][0-9]*$/.test(url.searchParams.get("page") ?? ""))
    throw new Error("GitHub pagination page is invalid");
  return url;
}

async function githubPages<T>(input: {
  fetcher: GithubFetch;
  token: string;
  initialUrl: string;
  parse: (value: unknown) => T[];
}): Promise<T[]> {
  const initial = new URL(input.initialUrl);
  let current = initial;
  const visited = new Set<string>();
  const result: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    if (visited.has(current.href))
      throw new Error("GitHub pagination contains a cycle");
    visited.add(current.href);
    const response = await githubResponse(
      input.fetcher,
      input.token,
      current.href,
    );
    const items = input.parse(response.value);
    if (items.length > pageSize)
      throw new Error("GitHub API page exceeds the requested size");
    result.push(...items);
    const next = nextLink(response.link);
    if (!next) return result;
    current = paginationUrl(next, initial);
  }
  throw new Error("GitHub pagination exceeded its page limit");
}

const objectSchema = z.object({
  sha: deploymentShaSchema,
  type: z.enum(["commit", "tag"]),
});

async function peelTag(input: {
  fetcher: GithubFetch;
  token: string;
  repository: Repository;
  tag: string;
}): Promise<{ commitSha: string; tagObjectSha: string }> {
  const reference = z
    .object({ object: objectSchema })
    .passthrough()
    .parse(
      await githubJson(
        input.fetcher,
        input.token,
        api(input.repository, `/git/ref/tags/${encodeURIComponent(input.tag)}`),
      ),
    );
  const tagObjectSha = reference.object.sha;
  let object = reference.object;
  const visited = new Set<string>();
  for (let depth = 0; object.type === "tag" && depth < 5; depth += 1) {
    if (visited.has(object.sha))
      throw new Error("Release tag contains a cycle");
    visited.add(object.sha);
    object = z
      .object({ object: objectSchema })
      .passthrough()
      .parse(
        await githubJson(
          input.fetcher,
          input.token,
          api(input.repository, `/git/tags/${object.sha}`),
        ),
      ).object;
  }
  if (object.type !== "commit")
    throw new Error("Release tag did not peel to a commit");
  return { commitSha: object.sha, tagObjectSha };
}

const deploymentSchema = z
  .object({
    id: idSchema,
    sha: deploymentShaSchema,
    environment: z.literal("staging"),
    created_at: timestampSchema,
    creator: z.object({ login: z.string(), type: z.string() }),
    payload: z.unknown(),
  })
  .passthrough();
const statusSchema = z
  .object({
    id: idSchema,
    state: z.enum([
      "error",
      "failure",
      "inactive",
      "in_progress",
      "queued",
      "pending",
      "success",
    ]),
    created_at: timestampSchema,
  })
  .passthrough();
const jobSchema = z
  .object({
    name: z.string(),
    conclusion: z.string().nullable(),
    head_sha: deploymentShaSchema,
  })
  .passthrough();

function uniqueById<T extends { id: number }>(items: T[], label: string): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(`GitHub ${label} response contains duplicate records`);
  return items;
}

function newest<T extends { id: number; created_at: string }>(
  items: T[],
  label: string,
): T {
  const sorted = uniqueById(items, label).sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      right.id - left.id,
  );
  if (!sorted[0]) throw new Error(`No ${label} records exist`);
  return sorted[0];
}

function deploymentRun(payload: unknown, expectedSha: string) {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  return z
    .object({
      workflow_run_id: idSchema,
      workflow_run_attempt: idSchema,
      workflow_path: z.literal(workflowPath),
      sha: z.literal(expectedSha),
    })
    .strict()
    .parse(value);
}

export type ReleaseValidation = Readonly<{
  tag: string;
  sha: string;
  releaseId: number;
  releaseUpdatedAt: string;
  tagObjectSha: string;
  stagingDeploymentId: number;
  stagingStatusId: number;
  stagingRunId: number;
  stagingRunAttempt: number;
}>;

export async function validateReleaseCandidate(input: {
  repository: string;
  token: string;
  tag: string;
  sha: string;
  fetcher?: GithubFetch;
}): Promise<ReleaseValidation> {
  const repository = repositorySchema.parse(input.repository);
  const token = z.string().trim().min(1).parse(input.token);
  const tag = tagSchema.parse(input.tag);
  const sha = deploymentShaSchema.parse(input.sha);
  const fetcher = input.fetcher ?? fetch;
  const release = z
    .object({
      id: idSchema,
      tag_name: z.literal(tag),
      draft: z.literal(false),
      prerelease: z.literal(false),
      updated_at: timestampSchema,
    })
    .passthrough()
    .parse(
      await githubJson(
        fetcher,
        token,
        api(repository, `/releases/tags/${encodeURIComponent(tag)}`),
      ),
    );
  const peeled = await peelTag({ fetcher, token, repository, tag });
  if (peeled.commitSha !== sha)
    throw new Error("Release tag does not resolve to the requested SHA");
  const comparison = z
    .object({
      status: z.enum(["ahead", "identical"]),
      merge_base_commit: z.object({ sha: deploymentShaSchema }),
    })
    .passthrough()
    .parse(
      await githubJson(
        fetcher,
        token,
        api(repository, `/compare/${sha}...main`),
      ),
    );
  if (comparison.merge_base_commit.sha !== sha)
    throw new Error("Release SHA is not reachable from main");
  const deployments = await githubPages({
    fetcher,
    token,
    initialUrl: api(
      repository,
      `/deployments?sha=${sha}&environment=staging&per_page=${pageSize}`,
    ),
    parse: (value) => z.array(deploymentSchema).parse(value),
  });
  const deployment = newest(
    deployments.filter(
      (candidate) =>
        candidate.sha === sha && candidate.environment === "staging",
    ),
    "staging deployment",
  );
  z.object({
    login: z.literal("github-actions[bot]"),
    type: z.literal("Bot"),
  }).parse(deployment.creator);
  const expectedRun = deploymentRun(deployment.payload, sha);
  const statuses = await githubPages({
    fetcher,
    token,
    initialUrl: api(
      repository,
      `/deployments/${deployment.id}/statuses?per_page=${pageSize}`,
    ),
    parse: (value) => z.array(statusSchema).parse(value),
  });
  const status = newest(statuses, "staging deployment status");
  if (status.state !== "success")
    throw new Error("Latest staging deployment status is not successful");
  const run = z
    .object({
      id: z.literal(expectedRun.workflow_run_id),
      run_attempt: z.literal(expectedRun.workflow_run_attempt),
      event: z.literal("push"),
      head_sha: z.literal(sha),
      head_branch: z.literal("main"),
      path: workflowRunPathSchema,
      repository: z.object({ full_name: z.literal(repository.fullName) }),
      head_repository: z.object({ full_name: z.literal(repository.fullName) }),
    })
    .passthrough()
    .parse(
      await githubJson(
        fetcher,
        token,
        api(repository, `/actions/runs/${expectedRun.workflow_run_id}`),
      ),
    );
  const jobs = await githubPages({
    fetcher,
    token,
    initialUrl: api(
      repository,
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${pageSize}`,
    ),
    parse: (value) =>
      z
        .object({ jobs: z.array(jobSchema) })
        .passthrough()
        .parse(value).jobs,
  });
  const stagingJobs = jobs.filter((job) => job.name === "Deploy staging");
  if (stagingJobs.length !== 1)
    throw new Error("Workflow attempt must contain one Deploy staging job");
  const stagingJob = stagingJobs[0];
  if (stagingJob.head_sha !== sha || stagingJob.conclusion !== "success")
    throw new Error("Deploy staging job did not succeed for the release SHA");
  return {
    tag,
    sha,
    releaseId: release.id,
    releaseUpdatedAt: release.updated_at,
    tagObjectSha: peeled.tagObjectSha,
    stagingDeploymentId: deployment.id,
    stagingStatusId: status.id,
    stagingRunId: run.id,
    stagingRunAttempt: run.run_attempt,
  };
}

export async function createStagingDeployment(input: {
  repository: string;
  token: string;
  sha: string;
  runId: number;
  runAttempt: number;
  fetcher?: GithubFetch;
}): Promise<number> {
  const repository = repositorySchema.parse(input.repository);
  const token = z.string().trim().min(1).parse(input.token);
  const sha = deploymentShaSchema.parse(input.sha);
  const runId = idSchema.parse(input.runId);
  const runAttempt = idSchema.parse(input.runAttempt);
  const result = z
    .object({ id: idSchema })
    .passthrough()
    .parse(
      await githubJson(
        input.fetcher ?? fetch,
        token,
        api(repository, "/deployments"),
        {
          method: "POST",
          body: JSON.stringify({
            ref: sha,
            environment: "staging",
            auto_merge: false,
            required_contexts: [],
            transient_environment: false,
            production_environment: false,
            payload: {
              workflow_run_id: runId,
              workflow_run_attempt: runAttempt,
              workflow_path: workflowPath,
              sha,
            },
          }),
        },
      ),
    );
  return result.id;
}

export async function setDeploymentStatus(input: {
  repository: string;
  token: string;
  deploymentId: number;
  state: "in_progress" | "success" | "failure";
  environmentUrl?: string;
  fetcher?: GithubFetch;
}): Promise<void> {
  const repository = repositorySchema.parse(input.repository);
  await githubJson(
    input.fetcher ?? fetch,
    z.string().trim().min(1).parse(input.token),
    api(
      repository,
      `/deployments/${idSchema.parse(input.deploymentId)}/statuses`,
    ),
    {
      method: "POST",
      body: JSON.stringify({
        state: input.state,
        environment: "staging",
        auto_inactive: false,
        ...(input.environmentUrl
          ? { environment_url: input.environmentUrl }
          : {}),
      }),
    },
  );
}

async function output(values: Record<string, string>): Promise<void> {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(
    target,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function validationOutput(result: ReleaseValidation): Record<string, string> {
  return {
    tag_name: result.tag,
    sha: result.sha,
    release_id: String(result.releaseId),
    release_updated_at: result.releaseUpdatedAt,
    tag_object_sha: result.tagObjectSha,
    staging_deployment_id: String(result.stagingDeploymentId),
    staging_status_id: String(result.stagingStatusId),
    staging_run_id: String(result.stagingRunId),
    staging_run_attempt: String(result.stagingRunAttempt),
  };
}

export function assertExpectedReleaseValidation(
  result: ReleaseValidation,
  source: Readonly<Record<string, string | undefined>>,
): void {
  const expectedKeys = [
    "EXPECTED_RELEASE_ID",
    "EXPECTED_RELEASE_UPDATED_AT",
    "EXPECTED_TAG_OBJECT_SHA",
    "EXPECTED_STAGING_DEPLOYMENT_ID",
    "EXPECTED_STAGING_STATUS_ID",
    "EXPECTED_STAGING_RUN_ID",
    "EXPECTED_STAGING_RUN_ATTEMPT",
  ] as const;
  const present = expectedKeys.filter((key) => source[key] !== undefined);
  if (present.length === 0) return;
  if (present.length !== expectedKeys.length)
    throw new Error("Expected release provenance is incomplete");
  const expected = {
    releaseId: idSchema.parse(source.EXPECTED_RELEASE_ID),
    releaseUpdatedAt: timestampSchema.parse(source.EXPECTED_RELEASE_UPDATED_AT),
    tagObjectSha: deploymentShaSchema.parse(source.EXPECTED_TAG_OBJECT_SHA),
    stagingDeploymentId: idSchema.parse(source.EXPECTED_STAGING_DEPLOYMENT_ID),
    stagingStatusId: idSchema.parse(source.EXPECTED_STAGING_STATUS_ID),
    stagingRunId: idSchema.parse(source.EXPECTED_STAGING_RUN_ID),
    stagingRunAttempt: idSchema.parse(source.EXPECTED_STAGING_RUN_ATTEMPT),
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>)
    if (expected[key] !== result[key])
      throw new Error("Release provenance changed after public validation");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "release-output") {
    const created = process.env.RELEASE_CREATED === "true";
    if (!created)
      return output({ release_created: "false", tag_name: "", sha: "" });
    const tag = tagSchema.parse(process.env.RELEASE_TAG);
    const sha = deploymentShaSchema.parse(process.env.RELEASE_SHA);
    const stagedSha = deploymentShaSchema.parse(process.env.STAGED_SHA);
    if (sha !== stagedSha)
      throw new Error("Release SHA differs from staged SHA");
    return output({ release_created: "true", tag_name: tag, sha });
  }
  const repository = repositorySchema.parse(process.env.GITHUB_REPOSITORY);
  const token = z.string().trim().min(1).parse(process.env.GITHUB_TOKEN);
  if (command === "validate-release") {
    const result = await validateReleaseCandidate({
      repository: repository.fullName,
      token,
      tag: process.env.RELEASE_TAG ?? "",
      sha: process.env.RELEASE_SHA ?? "",
    });
    assertExpectedReleaseValidation(result, process.env);
    await output(validationOutput(result));
    return;
  }
  if (command === "create-staging-deployment") {
    const id = await createStagingDeployment({
      repository: repository.fullName,
      token,
      sha: process.env.DEPLOYMENT_SHA ?? "",
      runId: idSchema.parse(process.env.GITHUB_RUN_ID),
      runAttempt: idSchema.parse(process.env.GITHUB_RUN_ATTEMPT),
    });
    await setDeploymentStatus({
      repository: repository.fullName,
      token,
      deploymentId: id,
      state: "in_progress",
    });
    await output({ deployment_id: String(id) });
    return;
  }
  if (command === "set-staging-status") {
    const state = z
      .enum(["success", "failure"])
      .parse(process.env.DEPLOYMENT_STATE);
    await setDeploymentStatus({
      repository: repository.fullName,
      token,
      deploymentId: idSchema.parse(process.env.DEPLOYMENT_ID),
      state,
      ...(state === "success" && process.env.APP_URL
        ? { environmentUrl: process.env.APP_URL }
        : {}),
    });
    return;
  }
  throw new Error("Unknown Cloudflare GitHub delivery command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.github] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
