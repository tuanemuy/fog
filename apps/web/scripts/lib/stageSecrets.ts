import {
  type DeployStage,
  isDeployStage,
  secretFiles,
  WORKER_ROLES,
  type WorkerRole,
  wranglerConfigFiles,
} from "./deployStage";
import type { SecretRoster } from "./secretRoster";

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

type KeyCheck =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; problem: string }>;

/** Whether `key` may be uploaded to `worker` with this value. */
function checkKey(
  worker: WorkerRole,
  key: string,
  value: unknown,
  roster: SecretRoster,
): KeyCheck {
  const refuse = (problem: string): KeyCheck => ({ ok: false, problem });
  const entry = roster.entries.find((candidate) => candidate.name === key);
  if (entry === undefined) {
    return refuse("is not in the roster of .dev.vars.example");
  }
  if (entry.kind === "localOnly") {
    return refuse("is local only and must not be deployed");
  }
  if (entry.kind === "var") return refuse("is a [vars] entry, not a secret");
  if (entry.owner !== worker) {
    return refuse(`belongs to the ${entry.owner} Worker`);
  }
  if (typeof value !== "string") return refuse("is not a string");
  if (value.trim() === "") return refuse("is empty");
  if (value.trim() === roster.developmentValues[key]?.trim()) {
    return refuse("still holds the development value from .dev.vars.example");
  }
  return { ok: true, value };
}

type CheckedFile = Readonly<{
  problems: readonly string[];
  secrets: Readonly<Record<string, string>>;
}>;

function checkFile(
  worker: WorkerRole,
  file: SecretFile,
  roster: SecretRoster,
  label: string,
): CheckedFile {
  const keys = Object.keys(file).filter((key) => !isNote(key));
  const missing = roster.entries.flatMap((entry) =>
    entry.kind === "secret" &&
    entry.owner === worker &&
    !entry.rotationOnly &&
    !keys.includes(entry.name)
      ? [`${label}: ${entry.name} is missing`]
      : [],
  );
  const checks = keys.map(
    (key) => [key, checkKey(worker, key, file[key], roster)] as const,
  );
  return {
    problems: [
      ...missing,
      ...checks.flatMap(([key, check]) =>
        check.ok ? [] : [`${label}: ${key} ${check.problem}`],
      ),
    ],
    secrets: Object.fromEntries(
      checks.flatMap(([key, check]) => (check.ok ? [[key, check.value]] : [])),
    ),
  };
}

/**
 * Check a stage's two decrypted secret files against the roster, and plan
 * one upload per Worker against that Worker's own config.
 *
 * Every problem is collected before any is reported, and none of them
 * quotes a value. A plan exists only when there are none, and each upload
 * holds exactly the keys of its own Worker's file that passed, less the
 * `_` notes.
 */
export function planSecretUploads(
  stage: DeployStage,
  files: Readonly<Record<WorkerRole, SecretFile>>,
  roster: SecretRoster,
): SecretPlan {
  const labels = secretFiles(stage);
  const configs = wranglerConfigFiles(stage);
  const checked = WORKER_ROLES.map((worker) => ({
    worker,
    ...checkFile(worker, files[worker], roster, labels[worker]),
  }));
  const problems = checked.flatMap((file) => file.problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    uploads: checked.map(({ worker, secrets }) => ({
      worker,
      config: configs[worker],
      secrets,
    })),
  };
}

const UPLOADED = /(\d+) secrets successfully uploaded/;

/**
 * Whether `wrangler secret bulk`'s output confirms the whole upload.
 * wrangler exits 0 without uploading anything when its input is empty or
 * unreadable, so its exit code alone does not say the secrets arrived.
 */
export function uploadConfirmationProblem(
  upload: SecretUpload,
  output: string,
): string | null {
  const expected = Object.keys(upload.secrets).length;
  const confirmed = UPLOADED.exec(output)?.[1];
  return confirmed === String(expected)
    ? null
    : `wrangler did not confirm uploading ${expected} secrets to the ${upload.worker} Worker`;
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
 * Where the secrets a Worker actually holds differ, by name, from what was
 * just uploaded to it. `wrangler secret bulk` adds and overwrites but never
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

export const SECRET_COMMANDS = ["check", "push"] as const;
export type SecretCommand = (typeof SECRET_COMMANDS)[number];

export type SecretCommandArgs = Readonly<{
  command: SecretCommand;
  stage: DeployStage;
}>;

/** `<check|push> <stage>`, and nothing else. */
export function parseSecretCommandArgs(
  args: readonly string[],
): SecretCommandArgs | null {
  const [command, stage, ...rest] = args;
  const isCommand = (value: string | undefined): value is SecretCommand =>
    (SECRET_COMMANDS as readonly (string | undefined)[]).includes(value);
  return isCommand(command) &&
    stage !== undefined &&
    isDeployStage(stage) &&
    rest.length === 0
    ? { command, stage }
    : null;
}

/** The side effects `runSecretCommand` needs, so a test can stand in for sops and wrangler. */
export type SecretCommandIo = Readonly<{
  /** `sops --decrypt` of a file relative to `apps/web`, as text held in memory. */
  decrypt: (file: string) => string;
  /** `wrangler secret bulk --config <config>` with the JSON on stdin; returns its output. */
  upload: (config: string, json: string) => string;
  /** `wrangler secret list --config <config> --format json`. */
  list: (config: string) => string;
  report: (line: string) => void;
}>;

/**
 * `check` decrypts a stage's two secret files and checks them; `push`
 * does the same, uploads each Worker's secrets against its own config
 * only when the check passes for both, then confirms each upload and
 * compares the names each Worker holds with its file. Returns whether the
 * command succeeded.
 */
export function runSecretCommand(
  { command, stage }: SecretCommandArgs,
  roster: SecretRoster,
  io: SecretCommandIo,
): boolean {
  const files = secretFiles(stage);
  const read = (worker: WorkerRole) =>
    parseSecretFile(io.decrypt(files[worker]), files[worker]);
  const plan = planSecretUploads(
    stage,
    { request: read("request"), state: read("state") },
    roster,
  );
  if (!plan.ok) {
    for (const problem of plan.problems) io.report(problem);
    return false;
  }
  io.report(`${files.request} and ${files.state} pass the check`);
  if (command === "check") return true;

  const unconfirmed = plan.uploads.flatMap((upload) => {
    const problem = uploadConfirmationProblem(
      upload,
      io.upload(upload.config, JSON.stringify(upload.secrets)),
    );
    return problem === null ? [] : [problem];
  });
  const problems = [
    ...unconfirmed,
    ...plan.uploads.flatMap((upload) =>
      deployedSecretProblems(
        upload,
        parseSecretList(io.list(upload.config), upload.config),
        roster,
      ),
    ),
  ];
  for (const problem of problems) io.report(problem);
  return problems.length === 0;
}
