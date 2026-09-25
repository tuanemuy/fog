export const DEPLOY_STAGES = ["staging", "production"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

export function isDeployStage(value: string): value is DeployStage {
  return (DEPLOY_STAGES as readonly string[]).includes(value);
}

export type WranglerConfigFiles = Readonly<{ request: string; state: string }>;

/**
 * The pair of wrangler configs one build reads, relative to `apps/web`:
 * the local pair for `null`, the rendered pair for a stage. The render
 * script writes to these same names, so what it renders is what the stage
 * build picks up.
 */
export function wranglerConfigFiles(
  stage: DeployStage | null,
): WranglerConfigFiles {
  return stage === null
    ? { request: "wrangler.toml", state: "wrangler.state.toml" }
    : {
        request: `wrangler.${stage}.toml`,
        state: `wrangler.state.${stage}.toml`,
      };
}

/** The committed template a rendered stage config comes from. */
export function templateFileOf(renderedFile: string): string {
  return `${renderedFile}.tpl`;
}
