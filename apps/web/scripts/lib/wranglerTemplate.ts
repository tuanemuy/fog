export type Substitutions = Readonly<Record<string, string | undefined>>;

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
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = substitutions[name];
    if (value === undefined) {
      throw new Error(
        `Unknown placeholder \${${name}} in ${templateLabel}. ` +
          `Known: ${Object.keys(substitutions).join(", ")}`,
      );
    }
    return value;
  });
}
