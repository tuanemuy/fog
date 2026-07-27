#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Stage = "staging" | "production";
type SecretRecord = Readonly<{ name: string }>;

const requestOnlySecrets = new Set([
  "SESSION_SECRET",
  "DIRECTORY_ROUTING_SECRET_ACTIVE",
  "DIRECTORY_ROUTING_SECRET_PREVIOUS",
  "PITR_OPERATOR_TOKEN",
]);

export function validateSecretInventory(input: {
  required: readonly string[];
  configured: readonly SecretRecord[];
  forbidden?: ReadonlySet<string>;
  allowed?: ReadonlySet<string>;
}): string[] {
  const configured = new Set(input.configured.map(({ name }) => name));
  const failures = input.required
    .filter((name) => !configured.has(name))
    .map((name) => `missing required secret ${name}`);
  for (const name of configured) {
    if (input.forbidden?.has(name)) {
      failures.push(`forbidden request-only secret is present: ${name}`);
    } else if (input.allowed !== undefined && !input.allowed.has(name)) {
      failures.push(`unexpected secret is present: ${name}`);
    }
  }
  return failures;
}

function requiredSecrets(config: string): string[] {
  const section = /^\[secrets\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/mu.exec(
    config,
  )?.[1];
  const required = /^\s*required\s*=\s*\[([^\]]*)\]/mu.exec(section ?? "")?.[1];
  if (required === undefined) {
    throw new Error("config is missing [secrets].required");
  }
  return [...required.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function listSecrets(configPath: string): SecretRecord[] {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "secret", "list", "--config", configPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed: unknown = JSON.parse(output);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        !("name" in item) ||
        typeof item.name !== "string",
    )
  ) {
    throw new Error("Wrangler returned an invalid secret inventory");
  }
  return parsed as SecretRecord[];
}

function isStage(value: string | undefined): value is Stage {
  return value === "staging" || value === "production";
}

function main(): void {
  const stage = process.argv[2];
  if (!isStage(stage)) {
    throw new Error("usage: validate-secrets.ts <staging|production>");
  }
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = [];
  for (const worker of ["request", "state"] as const) {
    const relativeConfig = `wrangler.${worker}.${stage}.toml`;
    const configPath = resolve(webRoot, relativeConfig);
    const required = requiredSecrets(readFileSync(configPath, "utf8"));
    const configured = listSecrets(relativeConfig);
    failures.push(
      ...validateSecretInventory({
        required,
        configured,
        allowed: new Set(required),
        ...(worker === "state" ? { forbidden: requestOnlySecrets } : {}),
      }).map((failure) => `${worker}: ${failure}`),
    );
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log(
    `${stage} secret inventory is complete; no secret values were read`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
