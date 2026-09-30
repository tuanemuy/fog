import {
  type DeployStage,
  secretFiles,
  type WorkerRole,
  wranglerConfigFiles,
} from "./deployStage";
import type { SecretRoster } from "./secretRoster";

/** The Workers in the order their secrets are uploaded. */
const WORKERS: readonly WorkerRole[] = ["state", "request"];

/** A decrypted secret file: a JSON object, its values not yet checked. */
export type SecretFile = Readonly<Record<string, unknown>>;

export type SecretUpload = Readonly<{
  worker: WorkerRole;
  /** The wrangler config the upload is made against, relative to `apps/web`. */
  config: string;
  secrets: Readonly<Record<string, string>>;
}>;

export type SecretPlan =
  | Readonly<{ ok: true; uploads: readonly SecretUpload[] }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

/** Keys starting with `_` are notes for whoever edits the file, never secrets. */
const isNote = (key: string) => key.startsWith("_");

/**
 * Parse one decrypted file. Only an object of named values can be checked
 * against the roster, so anything else is refused here.
 */
export function parseSecretFile(text: string, label: string): SecretFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as SecretFile;
}

function problemsOf(
  worker: WorkerRole,
  file: SecretFile,
  roster: SecretRoster,
  label: string,
): string[] {
  const keys = Object.keys(file).filter((key) => !isNote(key));

  const missing = roster.entries.flatMap((entry) =>
    entry.kind === "secret" &&
    entry.owner === worker &&
    !entry.rotationOnly &&
    !keys.includes(entry.name)
      ? [`${label}: ${entry.name} is missing`]
      : [],
  );

  const present = keys.flatMap((key) => {
    const problem = keyProblem(worker, key, file[key], roster);
    return problem === null ? [] : [`${label}: ${key} ${problem}`];
  });

  return [...missing, ...present];
}

/** Why `key` must not be uploaded to `worker` with this value, or `null`. */
function keyProblem(
  worker: WorkerRole,
  key: string,
  value: unknown,
  roster: SecretRoster,
): string | null {
  const entry = roster.entries.find((candidate) => candidate.name === key);
  if (entry === undefined) return "is not in the roster of .dev.vars.example";
  if (entry.kind === "localOnly")
    return "is local only and must not be deployed";
  if (entry.kind === "var") return "is a [vars] entry, not a secret";
  if (entry.owner !== worker) return `belongs to the ${entry.owner} Worker`;
  if (typeof value !== "string") return "is not a string";
  const development = roster.developmentValues[key];
  if (development === undefined || value.trim() !== development.trim()) {
    return null;
  }
  return value.trim() === ""
    ? "is empty"
    : "still holds the development value from .dev.vars.example";
}

/**
 * Check a stage's two decrypted secret files against the roster, and plan
 * one upload per Worker against that Worker's own config.
 *
 * Every problem is collected before any is reported, and none of them
 * quotes a value. A plan exists only when there are none, so an upload
 * can never carry a key the check has not passed: each upload holds
 * exactly the keys of its own Worker's file, less the `_` notes.
 */
export function planSecretUploads(
  stage: DeployStage,
  files: Readonly<Record<WorkerRole, SecretFile>>,
  roster: SecretRoster,
): SecretPlan {
  const labels = secretFiles(stage);
  const problems = WORKERS.flatMap((worker) =>
    problemsOf(worker, files[worker], roster, labels[worker]),
  );
  if (problems.length > 0) return { ok: false, problems };

  const configs = wranglerConfigFiles(stage);
  return {
    ok: true,
    uploads: WORKERS.map((worker) => ({
      worker,
      config: configs[worker],
      secrets: Object.fromEntries(
        Object.entries(files[worker]).flatMap(([key, value]) =>
          isNote(key) || typeof value !== "string" ? [] : [[key, value]],
        ),
      ),
    })),
  };
}

/**
 * Parse `wrangler secret list --format json`: an array of `{ name, type }`.
 * Only the names are kept; the listing never carries a value.
 */
export function parseSecretList(text: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the secret list of ${label} is not JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`the secret list of ${label} is not an array`);
  }
  return parsed.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("name" in item) ||
      typeof item.name !== "string"
    ) {
      throw new Error(`the secret list of ${label} has an entry with no name`);
    }
    return item.name;
  });
}

/**
 * Where the secrets a Worker actually holds differ from what was just
 * uploaded to it. `wrangler secret bulk` adds and overwrites but never
 * deletes, so a name left behind — put on the wrong Worker by hand, a
 * rotation variable after retirement, a key moved to the other file —
 * stays live until someone deletes it, and this is where it shows.
 */
export function deployedSecretProblems(
  upload: SecretUpload,
  deployed: readonly string[],
  roster: SecretRoster,
): string[] {
  const uploaded = Object.keys(upload.secrets);
  const stale = deployed
    .filter((name) => !uploaded.includes(name))
    .map((name) => {
      const entry = roster.entries.find((candidate) => candidate.name === name);
      const why =
        entry?.kind === "secret" && entry.owner !== upload.worker
          ? `it belongs to the ${entry.owner} Worker`
          : "it is not in the secret file";
      return (
        `the ${upload.worker} Worker holds ${name}, but ${why}. ` +
        `Delete it with \`wrangler secret delete ${name} --config ${upload.config}\``
      );
    });
  const absent = uploaded
    .filter((name) => !deployed.includes(name))
    .map(
      (name) =>
        `the ${upload.worker} Worker does not hold ${name} after the upload`,
    );
  return [...stale, ...absent];
}

export type SecretCommand = "check" | "push";

/** The side effects `runSecretCommand` needs, so a test can stand in for sops and wrangler. */
export type SecretCommandIo = Readonly<{
  /** `sops --decrypt` of a file relative to `apps/web`, as text held in memory. */
  decrypt: (file: string) => string;
  /** `wrangler secret bulk --config <config>`, with the JSON handed over stdin. */
  upload: (config: string, json: string) => void;
  /** `wrangler secret list --config <config> --format json`. */
  list: (config: string) => string;
  report: (line: string) => void;
}>;

/**
 * `check` decrypts a stage's two secret files and checks them; `push`
 * does the same, uploads each Worker's secrets against its own config
 * only when the check passes for both, then compares what each Worker
 * holds with what it was sent. Returns whether the command succeeded.
 */
export function runSecretCommand(
  command: SecretCommand,
  stage: DeployStage,
  roster: SecretRoster,
  io: SecretCommandIo,
): boolean {
  const files = secretFiles(stage);
  const decrypted = {
    request: parseSecretFile(io.decrypt(files.request), files.request),
    state: parseSecretFile(io.decrypt(files.state), files.state),
  };
  const plan = planSecretUploads(stage, decrypted, roster);
  if (!plan.ok) {
    for (const problem of plan.problems) io.report(problem);
    return false;
  }
  io.report(`${files.request} and ${files.state} pass the check`);
  if (command === "check") return true;

  for (const upload of plan.uploads) {
    io.upload(upload.config, JSON.stringify(upload.secrets));
  }
  const problems = plan.uploads.flatMap((upload) =>
    deployedSecretProblems(
      upload,
      parseSecretList(io.list(upload.config), upload.config),
      roster,
    ),
  );
  for (const problem of problems) io.report(problem);
  return problems.length === 0;
}
