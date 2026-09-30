/**
 * Check, or check and upload, a stage's secrets from its SOPS-encrypted
 * files `secrets/<stage>.<request|state>.enc.json`.
 *
 * Usage:
 *   tsx scripts/stage-secrets.ts <check|push> <stage>
 *
 * `check` needs `sops` and the stage's age key (`SOPS_AGE_KEY` or a key
 * file sops finds); `push` also needs wrangler to be authenticated and the
 * stage's configs rendered, since it uploads against them. The decrypted
 * text is held in this process and handed to wrangler over stdin — it is
 * never written to a file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_STAGES, isDeployStage } from "./lib/deployStage";
import { parseSecretRoster } from "./lib/secretRoster";
import { runSecretCommand } from "./lib/stageSecrets";

const [command, stage] = process.argv.slice(2);
if (
  (command !== "check" && command !== "push") ||
  stage === undefined ||
  !isDeployStage(stage)
) {
  console.error(
    `usage: tsx scripts/stage-secrets.ts <check|push> <${DEPLOY_STAGES.join("|")}>`,
  );
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(webRoot, "node_modules/.bin/wrangler");

try {
  const ok = runSecretCommand(
    command,
    stage,
    parseSecretRoster(
      readFileSync(resolve(webRoot, ".dev.vars.example"), "utf8"),
    ),
    {
      decrypt: (file) =>
        execFileSync("sops", ["--decrypt", "--output-type", "json", file], {
          cwd: webRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      upload: (config, json) => {
        execFileSync(wrangler, ["secret", "bulk", "--config", config], {
          cwd: webRoot,
          input: json,
          stdio: ["pipe", "inherit", "inherit"],
        });
      },
      list: (config) =>
        execFileSync(
          wrangler,
          ["secret", "list", "--config", config, "--format", "json"],
          {
            cwd: webRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          },
        ),
      report: (line) => console.log(line),
    },
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
