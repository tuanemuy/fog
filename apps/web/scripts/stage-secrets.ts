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
import { DEPLOY_STAGES } from "./lib/deployStage";
import { parseSecretRoster } from "./lib/secretRoster";
import {
  parseSecretCommandArgs,
  runSecretCommand,
  SECRET_COMMANDS,
} from "./lib/stageSecrets";

const args = parseSecretCommandArgs(process.argv.slice(2));
if (args === null) {
  console.error(
    `usage: tsx scripts/stage-secrets.ts <${SECRET_COMMANDS.join("|")}> <${DEPLOY_STAGES.join("|")}>`,
  );
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(webRoot, "node_modules/.bin/wrangler");

try {
  const ok = runSecretCommand(
    args,
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
        const output = execFileSync(
          wrangler,
          ["secret", "bulk", "--config", config],
          {
            cwd: webRoot,
            encoding: "utf8",
            input: json,
            stdio: ["pipe", "pipe", "inherit"],
          },
        );
        // Key names and counts only; wrangler never prints a value.
        process.stdout.write(output);
        return output;
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
