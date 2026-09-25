import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_STAGES,
  templateFileOf,
  wranglerConfigFiles,
} from "../lib/deployStage";
import {
  placeholdersIn,
  renderWranglerTemplate,
  stageSubstitutions,
  WRANGLER_PLACEHOLDER_SOURCES,
} from "../lib/wranglerTemplate";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const placeholder = (name: string) => `$\{${name}}`;

const STACK_OUTPUTS = {
  exportedAppUrl: "https://fog.example",
  eventsQueueName: "fog-staging-events",
  dlqQueueName: "fog-staging-events-dlq",
  exportedPrefix: "fog-staging",
};
const ENV = { MAIL_FROM_ADDRESS: "fog <mail@fog.example>" };

describe("renderWranglerTemplate", () => {
  it("substitutes every occurrence of every placeholder", () => {
    const prefix = placeholder("PREFIX");
    expect(
      renderWranglerTemplate(
        `name = "${prefix}"\nscript_name = "${prefix}-state"\nurl = "${placeholder("APP_URL")}"`,
        { PREFIX: "fog-staging", APP_URL: "https://fog.example" },
        "t.tpl",
      ),
    ).toBe(
      'name = "fog-staging"\nscript_name = "fog-staging-state"\nurl = "https://fog.example"',
    );
  });

  it.each([
    ["undefined", { KNOWN: "x", MISSING: undefined }],
    ["absent", { KNOWN: "x" }],
  ])(
    "aborts on a placeholder whose value is %s, naming it, the template and the placeholders that have a value",
    (_, substitutions) => {
      expect(() =>
        renderWranglerTemplate(
          `a = "${placeholder("KNOWN")}"\nb = "${placeholder("MISSING")}"`,
          substitutions,
          "wrangler.staging.toml.tpl",
        ),
      ).toThrow(
        new Error(
          `No value for placeholder ${placeholder("MISSING")} in wrangler.staging.toml.tpl. Placeholders with a value: KNOWN`,
        ),
      );
    },
  );

  it("substitutes an empty string rather than treating it as missing", () => {
    expect(
      renderWranglerTemplate(
        `a = "${placeholder("EMPTY")}"`,
        { EMPTY: "" },
        "t",
      ),
    ).toBe('a = ""');
  });

  it("leaves text that is not a placeholder untouched", () => {
    const text = `cost = $5 {x} ${placeholder("lower")}`;
    expect(renderWranglerTemplate(text, {}, "t")).toBe(text);
  });
});

describe("placeholdersIn", () => {
  it("collects each name once, from comment lines as well as values", () => {
    expect(
      placeholdersIn(
        `# run ${placeholder("A")} first\nx = "${placeholder("B")}-${placeholder("A")}"\ny = "${placeholder("lower")}"`,
      ),
    ).toEqual(new Set(["A", "B"]));
  });
});

describe("stageSubstitutions", () => {
  it("takes each placeholder from its stack output or environment variable", () => {
    expect(stageSubstitutions(STACK_OUTPUTS, ENV)).toEqual({
      APP_URL: "https://fog.example",
      EVENTS_QUEUE_NAME: "fog-staging-events",
      DLQ_QUEUE_NAME: "fog-staging-events-dlq",
      RESOURCE_PREFIX: "fog-staging",
      MAIL_FROM_ADDRESS: "fog <mail@fog.example>",
    });
  });

  const render = (
    stackOutputs: Record<string, unknown>,
    env: Record<string, string | undefined>,
  ) =>
    renderWranglerTemplate(
      `a = "${placeholder("APP_URL")}"\nb = "${placeholder("MAIL_FROM_ADDRESS")}"`,
      stageSubstitutions(stackOutputs, env),
      "t.tpl",
    );

  it("stops the render on a stack output the stack did not produce", () => {
    const { exportedAppUrl: _, ...withoutAppUrl } = STACK_OUTPUTS;
    expect(() => render(withoutAppUrl, ENV)).toThrow(
      `No value for placeholder ${placeholder("APP_URL")} in t.tpl.`,
    );
  });

  it("stops the render on a stack output that is not a string", () => {
    expect(() =>
      render({ ...STACK_OUTPUTS, exportedAppUrl: { url: "x" } }, ENV),
    ).toThrow(`No value for placeholder ${placeholder("APP_URL")} in t.tpl.`);
  });

  it("stops the render when MAIL_FROM_ADDRESS is not set", () => {
    expect(() => render(STACK_OUTPUTS, {})).toThrow(
      `No value for placeholder ${placeholder("MAIL_FROM_ADDRESS")} in t.tpl.`,
    );
  });
});

// A placeholder the render supplies but no template reads is a value the
// deploy no longer needs; one a template reads but the render does not
// supply stops every render of that stage.
describe("the render supplies exactly the placeholders the templates use", () => {
  it("across every stage's request and state templates", () => {
    const used = new Set(
      DEPLOY_STAGES.flatMap((stage) => {
        const { request, state } = wranglerConfigFiles(stage);
        return [request, state].flatMap((file) => [
          ...placeholdersIn(
            readFileSync(resolve(webRoot, templateFileOf(file)), "utf8"),
          ),
        ]);
      }),
    );
    expect(used).toEqual(new Set(Object.keys(WRANGLER_PLACEHOLDER_SOURCES)));
  });
});
