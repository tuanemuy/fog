#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { AppStack } from "../lib/appStack.js";

const app = new App();

const account = process.env["CDK_DEFAULT_ACCOUNT"];
const region = process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";

const stages = ["staging", "production"] as const;

for (const stage of stages) {
  // Stage-keyed env vars: `TURSO_URL_STAGING`, `TURSO_AUTH_TOKEN_SECRET_ARN_STAGING`, `APP_URL_STAGING`, etc.
  const upper = stage.toUpperCase();
  const tursoUrl = process.env[`TURSO_URL_${upper}`];
  const tursoAuthSecretArn =
    process.env[`TURSO_AUTH_TOKEN_SECRET_ARN_${upper}`];
  const sessionSecretArn = process.env[`SESSION_SECRET_ARN_${upper}`];
  const appUrl = process.env[`APP_URL_${upper}`];

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
        `Stage "${stage}" is partially configured: ${missing.join(", ")} unset. Set them, or unset every variable of the stage to skip it.`,
      );
    }

    // Skip stages that have not been configured at all — synth stays
    // useful for the stage(s) that are wired up.
    continue;
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
