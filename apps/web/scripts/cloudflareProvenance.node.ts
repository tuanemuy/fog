import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  assertSafeWorkspacePath,
  atomicWriteSafeFile,
  buildRoot,
  readSafeFile,
  webRoot,
} from "./cloudflareFilesystem.node";
import type { DeploymentStage } from "./cloudflareStage";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(webRoot, "..", "..");
const serverRoot = path.join(buildRoot, "server");
const clientRoot = path.join(buildRoot, "client");

export const builtConfigPath = path.join(serverRoot, "wrangler.json");
export const builtEntryPath = path.join(serverRoot, "index.js");
export const provenancePath = path.join(serverRoot, "fog-provenance.json");

const provenanceSchema = z
  .object({
    version: z.literal(2),
    stage: z.enum(["staging", "production"]),
    gitSha: z.string().regex(/^[0-9a-f]{40}$/),
    gitClean: z.boolean(),
    workspaceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    sourceConfigDigest: z.string().regex(/^[0-9a-f]{64}$/),
    builtConfigDigest: z.string().regex(/^[0-9a-f]{64}$/),
    builtEntryDigest: z.string().regex(/^[0-9a-f]{64}$/),
    serverDigest: z.string().regex(/^[0-9a-f]{64}$/),
    clientDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type ArtifactProvenance = z.infer<typeof provenanceSchema>;
export type ArtifactProvenanceSnapshot = Omit<
  ArtifactProvenance,
  "version" | "gitClean"
>;

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function gitOutput(args: string[]): Promise<string> {
  return (await execute("git", args, { cwd: repositoryRoot })).stdout;
}

async function currentGitState(): Promise<{ sha: string; clean: boolean }> {
  const [sha, status] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"]),
    gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { sha: sha.trim(), clean: status.trim() === "" };
}

async function sourceWorkspaceDigest(): Promise<string> {
  const listed = await gitOutput([
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
  ]);
  const files = listed
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith(".goal-implement/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(repositoryRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function artifactTreeDigest(
  rootInput: string,
  excludedInputs: string[] = [],
): Promise<string> {
  const root = await assertSafeWorkspacePath(rootInput);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("Cloudflare artifact root must be a real directory");
  const excluded = new Set(excludedInputs.map((entry) => path.resolve(entry)));
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  const paths = entries
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((entry) => !excluded.has(entry))
    .sort();
  const hash = createHash("sha256");
  for (const entry of paths) {
    const metadata = await lstat(entry);
    if (metadata.isSymbolicLink())
      throw new Error(
        "Cloudflare artifact tree must not contain symbolic links",
      );
    const type = metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : undefined;
    if (!type)
      throw new Error("Cloudflare artifact tree contains an unsupported type");
    const safeEntry = await assertSafeWorkspacePath(entry, {
      requireFile: type === "file",
    });
    hash.update(path.relative(root, safeEntry));
    hash.update("\0");
    hash.update(type);
    hash.update("\0");
    hash.update((metadata.mode & 0o7777).toString(8));
    hash.update("\0");
    if (type === "file") {
      hash.update(await readFile(safeEntry));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export async function writeArtifactProvenance(
  stage: DeploymentStage,
  sourceConfigPath: string,
): Promise<ArtifactProvenance> {
  const [git, workspaceDigest, sourceConfig, builtConfig, builtEntry] =
    await Promise.all([
      currentGitState(),
      sourceWorkspaceDigest(),
      readSafeFile(sourceConfigPath),
      readSafeFile(builtConfigPath),
      readSafeFile(builtEntryPath),
    ]);
  const provenance: ArtifactProvenance = {
    version: 2,
    stage,
    gitSha: git.sha,
    gitClean: git.clean,
    workspaceDigest,
    sourceConfigDigest: digest(sourceConfig),
    builtConfigDigest: digest(builtConfig),
    builtEntryDigest: digest(builtEntry),
    serverDigest: await artifactTreeDigest(serverRoot, [provenancePath]),
    clientDigest: await artifactTreeDigest(clientRoot),
  };
  await atomicWriteSafeFile(
    provenancePath,
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

export async function validateArtifactProvenance(input: {
  stage: DeploymentStage;
  sourceConfigPath: string;
  requireClean: boolean;
}): Promise<ArtifactProvenance> {
  const provenance = provenanceSchema.parse(
    JSON.parse(await readSafeFile(provenancePath)),
  );
  const [
    git,
    workspaceDigest,
    sourceConfig,
    builtConfig,
    builtEntry,
    serverDigest,
    clientDigest,
  ] = await Promise.all([
    currentGitState(),
    sourceWorkspaceDigest(),
    readSafeFile(input.sourceConfigPath),
    readSafeFile(builtConfigPath),
    readSafeFile(builtEntryPath),
    artifactTreeDigest(serverRoot, [provenancePath]),
    artifactTreeDigest(clientRoot),
  ]);
  const actual: ArtifactProvenanceSnapshot = {
    stage: input.stage,
    gitSha: git.sha,
    workspaceDigest,
    sourceConfigDigest: digest(sourceConfig),
    builtConfigDigest: digest(builtConfig),
    builtEntryDigest: digest(builtEntry),
    serverDigest,
    clientDigest,
  };
  return assertArtifactProvenance(
    provenance,
    actual,
    input.requireClean,
    git.clean,
  );
}

export function assertArtifactProvenance(
  provenanceInput: unknown,
  actual: ArtifactProvenanceSnapshot,
  requireClean: boolean,
  currentGitClean: boolean,
): ArtifactProvenance {
  const provenance = provenanceSchema.parse(provenanceInput);
  for (const key of Object.keys(actual) as (keyof typeof actual)[])
    if (provenance[key] !== actual[key])
      throw new Error(`Cloudflare artifact provenance mismatch: ${key}`);
  if (requireClean && (!provenance.gitClean || !currentGitClean))
    throw new Error(
      "Cloudflare side effects require a clean checkout provenance",
    );
  return provenance;
}
