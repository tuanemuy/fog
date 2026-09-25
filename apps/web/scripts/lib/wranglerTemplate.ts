export type Substitutions = Readonly<Record<string, string | undefined>>;

type PlaceholderSource =
  | Readonly<{ stackOutput: string }>
  | Readonly<{ env: string }>;

/**
 * Every placeholder the deploy templates may use, and where its value comes
 * from: an output of the Cloudflare resources Pulumi stack, or an
 * environment variable read at render time.
 */
export const WRANGLER_PLACEHOLDER_SOURCES = {
  APP_URL: { stackOutput: "exportedAppUrl" },
  EVENTS_QUEUE_NAME: { stackOutput: "eventsQueueName" },
  DLQ_QUEUE_NAME: { stackOutput: "dlqQueueName" },
  RESOURCE_PREFIX: { stackOutput: "exportedPrefix" },
  // Not a Pulumi resource: the sender is a property of the mail provider's
  // verified domain.
  MAIL_FROM_ADDRESS: { env: "MAIL_FROM_ADDRESS" },
} as const satisfies Record<string, PlaceholderSource>;

export type WranglerPlaceholder = keyof typeof WRANGLER_PLACEHOLDER_SOURCES;

const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * The substitutions for one stage, from the resources stack's
 * `pulumi stack output --json` and the environment. An output that is
 * missing or not a string is left `undefined`, so the render stops on it.
 */
export function stageSubstitutions(
  stackOutputs: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<WranglerPlaceholder, string | undefined>> {
  const valueFrom = (source: PlaceholderSource): string | undefined => {
    if ("env" in source) return env[source.env];
    const value = stackOutputs[source.stackOutput];
    return typeof value === "string" ? value : undefined;
  };
  return Object.fromEntries(
    Object.entries(WRANGLER_PLACEHOLDER_SOURCES).map(([name, source]) => [
      name,
      valueFrom(source),
    ]),
  ) as Record<WranglerPlaceholder, string | undefined>;
}

/** Every placeholder name in a template, comment lines included. */
export function placeholdersIn(template: string): Set<string> {
  return new Set(
    [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""),
  );
}

/**
 * Substitute every `${NAME}` in a wrangler config template. A name with no
 * value aborts instead of rendering an empty string, so a half-rendered
 * config never reaches a deploy.
 */
export function renderWranglerTemplate(
  template: string,
  substitutions: Substitutions,
  templateLabel: string,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = substitutions[name];
    if (value !== undefined) return value;
    throw new Error(
      name in substitutions
        ? `Placeholder \${${name}} in ${templateLabel} has no value.`
        : `Unknown placeholder \${${name}} in ${templateLabel}. ` +
            `Known: ${Object.keys(substitutions).join(", ")}`,
    );
  });
}
