#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { AppStack } from "../lib/appStack.js";

const app = new App();

// An unset secret in CI arrives as an empty string, not as an absent key
// (`FOO: ${{ secrets.MISSING }}` in GitHub Actions, `export FOO=` in a
// shell), so "" has to mean unset here too. Otherwise the checks below
// pass and the stack fails later inside `Secret.fromSecretCompleteArn`,
// which names no variable at all. Every env read in this file goes through
// here — `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` included, since those
// are exactly what CI passes from `secrets.` / `vars.`.
function read(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

const account = read("CDK_DEFAULT_ACCOUNT");
const region = read("CDK_DEFAULT_REGION") ?? "us-east-1";

const stages = ["staging", "production"] as const;

// `Secret.fromSecretCompleteArn` requires the full ARN including the
// six-character suffix Secrets Manager appends; a name or a partial ARN
// fails the same nameless way an empty string does.
//
// This is a heuristic, not a decision procedure: secret names may contain
// hyphens, so a partial ARN whose name ends in `-` plus six alphanumerics
// (`…:secret:my-config`) is indistinguishable from a complete one here and
// passes. It catches the common shapes (a bare name, an ARN truncated at
// the name) and nothing more.
const COMPLETE_SECRET_ARN =
  /^arn:[^:]+:secretsmanager:[^:]+:\d+:secret:.+-[A-Za-z0-9]{6}$/;

for (const stage of stages) {
  // Stage-keyed env vars: `TURSO_URL_STAGING`, `TURSO_AUTH_TOKEN_SECRET_ARN_STAGING`, `APP_URL_STAGING`, etc.
  const upper = stage.toUpperCase();
  const tursoUrl = read(`TURSO_URL_${upper}`);
  const tursoAuthSecretArn = read(`TURSO_AUTH_TOKEN_SECRET_ARN_${upper}`);
  const sessionSecretArn = read(`SESSION_SECRET_ARN_${upper}`);
  const appUrl = read(`APP_URL_${upper}`);

  const stageEnv = {
    [`TURSO_URL_${upper}`]: tursoUrl,
    [`TURSO_AUTH_TOKEN_SECRET_ARN_${upper}`]: tursoAuthSecretArn,
    [`SESSION_SECRET_ARN_${upper}`]: sessionSecretArn,
    [`APP_URL_${upper}`]: appUrl,
  };

  if (
    tursoUrl === undefined ||
    tursoAuthSecretArn === undefined ||
    sessionSecretArn === undefined ||
    appUrl === undefined
  ) {
    const missing = Object.entries(stageEnv)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);

    if (missing.length < Object.keys(stageEnv).length) {
      // A partially configured stage is a mistake, not an opt-out.
      // Skipping it silently yields a successful synth with the stack
      // absent, which surfaces later as "cdk deploy did nothing" with
      // no message to trace back to the unset variable.
      throw new Error(
        `Stage "${stage}" is partially configured: ${missing.join(", ")} unset or empty. Set them, or unset every variable of the stage to skip it.`,
      );
    }

    // Skip stages that have not been configured at all — synth stays
    // useful for the stage(s) that are wired up.
    continue;
  }

  const malformed = [
    [`TURSO_AUTH_TOKEN_SECRET_ARN_${upper}`, tursoAuthSecretArn],
    [`SESSION_SECRET_ARN_${upper}`, sessionSecretArn],
  ]
    .filter(
      ([, value]) => value !== undefined && !COMPLETE_SECRET_ARN.test(value),
    )
    .map(([key]) => key);

  if (malformed.length > 0) {
    throw new Error(
      `Stage "${stage}" has ${malformed.join(", ")} set to something other than a complete Secrets Manager ARN (arn:<partition>:secretsmanager:<region>:<account>:secret:<name>-<6 chars>).`,
    );
  }

  new AppStack(app, `AppStack-${stage}`, {
    env: { ...(account !== undefined ? { account } : {}), region },
    stage,
    tursoUrl,
    tursoAuthSecretArn,
    sessionSecretArn,
    appUrl,
  });
}
