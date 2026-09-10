import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DELIVERY_TUNING_DEFAULTS } from "@repo/core/application/delivery/tuning";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const repoRoot = resolve(webRoot, "../..");
const read = (name: string) => readFileSync(resolve(webRoot, name), "utf8");
const readRepo = (name: string) =>
  readFileSync(resolve(repoRoot, name), "utf8");

const DURABLE_OBJECT_CLASSES = [
  "IdentityDirectoryDurableObject",
  "UserDataDurableObject",
];

// `handleQueueBatch` routes a batch to the DLQ handler by this suffix and
// says in its own JSDoc that nothing in that module can check the name it
// matches against. This is where that check lives.
const DLQ_QUEUE_SUFFIX = "-dlq";

const REQUEST_CONFIGS = [
  "wrangler.toml",
  "wrangler.staging.toml.tpl",
  "wrangler.production.toml.tpl",
];
const STATE_CONFIGS = [
  "wrangler.state.toml",
  "wrangler.state.staging.toml.tpl",
  "wrangler.state.production.toml.tpl",
];
const DEPLOYED_CONFIGS = [
  ...REQUEST_CONFIGS.slice(1),
  ...STATE_CONFIGS.slice(1),
];

function topLevelName(toml: string): string | null {
  return /^name = "(.+)"$/m.exec(toml)?.[1] ?? null;
}

function durableObjectScriptNames(toml: string): string[] {
  return [...toml.matchAll(/^script_name = "(.+)"$/gm)].map((m) => m[1] ?? "");
}

function durableObjectClassNames(toml: string): string[] {
  return [...toml.matchAll(/^class_name = "(.+)"$/gm)].map((m) => m[1] ?? "");
}

function stringValue(toml: string, key: string): string | null {
  return new RegExp(`^${key} = "(.*)"`, "m").exec(toml)?.[1] ?? null;
}

function numberValue(toml: string, key: string): number | null {
  const raw = new RegExp(`^${key} = (\\d+)`, "m").exec(toml)?.[1];
  return raw === undefined ? null : Number(raw);
}

function stringArrayValue(toml: string, key: string): string[] | null {
  const body = new RegExp(`^${key} = \\[([\\s\\S]*?)\\]`, "m").exec(toml)?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** Bodies of every `[[header]]` array-of-tables entry, in file order. */
function tableBlocks(toml: string, header: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of toml.split("\n")) {
    if (line.startsWith("[")) {
      if (current !== null) blocks.push(current.join("\n"));
      current = line.trim() === `[[${header}]]` ? [] : null;
      continue;
    }
    current?.push(line);
  }
  if (current !== null) blocks.push(current.join("\n"));
  return blocks;
}

type QueueConsumer = Readonly<{
  queue: string | null;
  maxBatchSize: number | null;
  maxBatchTimeout: number | null;
  maxRetries: number | null;
  retryDelay: number | null;
  deadLetterQueue: string | null;
}>;

function queueConsumers(toml: string): QueueConsumer[] {
  return tableBlocks(toml, "queues.consumers").map((block) => ({
    queue: stringValue(block, "queue"),
    maxBatchSize: numberValue(block, "max_batch_size"),
    maxBatchTimeout: numberValue(block, "max_batch_timeout"),
    maxRetries: numberValue(block, "max_retries"),
    retryDelay: numberValue(block, "retry_delay"),
    deadLetterQueue: stringValue(block, "dead_letter_queue"),
  }));
}

function queueProducers(toml: string): ReadonlyArray<[string, string]> {
  return tableBlocks(toml, "queues.producers").map((block) => [
    stringValue(block, "binding") ?? "",
    stringValue(block, "queue") ?? "",
  ]);
}

/** Body of the first object literal at or after `from`. */
function braceBlockAt(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open === -1) throw new Error("no object literal found");
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces");
}

function objectLiteralAfter(source: string, key: string): string {
  const start = source.indexOf(`${key}:`);
  if (start === -1) throw new Error(`no \`${key}\` in the source`);
  return braceBlockAt(source, start);
}

/** `<name>: { … }` entries of an object literal body, in source order. */
function keyedEntries(body: string): ReadonlyArray<[string, string]> {
  return [...body.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*\{/g)].map(
    (m) => [m[1] ?? m[2] ?? "", braceBlockAt(body, m.index)],
  );
}

function jsNumber(body: string, key: string): number | null {
  const raw = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(body)?.[1];
  return raw === undefined ? null : Number(raw);
}

/** Seconds passed to `--message-retention-period-secs` in a deploy header. */
function retentionPeriodSecs(toml: string): number | null {
  const raw = /--message-retention-period-secs (\d+)/.exec(toml)?.[1];
  return raw === undefined ? null : Number(raw);
}

function jsString(body: string, key: string): string | null {
  return new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(body)?.[1] ?? null;
}

// `@cloudflare/vite-plugin` resolves a cross-Worker Durable Object
// binding by looking `script_name` up among the Worker names it knows,
// and **does nothing at all when the lookup misses** — no error at config
// load, no warning, just a binding that is never created. The only way
// that mismatch shows at runtime is by calling a DO stub, which the top
// page never does. The preview check makes one real round trip; this
// suite closes the same hole statically, and it catches the deployed
// stages too, which no local round trip reaches.
describe("request and state Worker configs agree on the script name", () => {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ["local", "wrangler.toml", "wrangler.state.toml"],
    [
      "staging template",
      "wrangler.staging.toml.tpl",
      "wrangler.state.staging.toml.tpl",
    ],
    [
      "production template",
      "wrangler.production.toml.tpl",
      "wrangler.state.production.toml.tpl",
    ],
  ];

  it.each(pairs)("%s", (_label, requestFile, stateFile) => {
    const stateName = topLevelName(read(stateFile));
    expect(stateName).not.toBeNull();

    const scriptNames = durableObjectScriptNames(read(requestFile));
    // Two namespaces, one per Durable Object class.
    expect(scriptNames).toHaveLength(2);
    for (const scriptName of scriptNames) {
      expect(scriptName).toBe(stateName);
    }
  });

  it.each(pairs)(
    "%s binds a namespace for exactly the classes the state Worker owns",
    (_label, requestFile, stateFile) => {
      expect([...durableObjectClassNames(read(requestFile))].sort()).toEqual(
        DURABLE_OBJECT_CLASSES,
      );
      expect(
        [
          ...(stringArrayValue(read(stateFile), "new_sqlite_classes") ?? []),
        ].sort(),
      ).toEqual(DURABLE_OBJECT_CLASSES);
    },
  );

  it.each(pairs)(
    "%s producer publishes into the queue the request Worker consumes",
    (_label, requestFile, stateFile) => {
      const producers = queueProducers(read(stateFile));
      expect(producers).toEqual([
        ["EVENTS_QUEUE", queueConsumers(read(requestFile))[0]?.queue],
      ]);
    },
  );
});

// A Durable Object declared through `new_classes` gets the key-value
// backend, where `ctx.storage.sql` and `transactionSync` do not exist —
// the whole storage contract this template is built on. Nothing else
// catches that swap: the DO test project forces SQLite through
// `vitest.config.do.ts`'s `useSQLite`, so the suites stay green while
// only the deployed Workers lose it.
describe("state configs put the Durable Objects on the SQLite backend", () => {
  it.each(STATE_CONFIGS)("%s", (file) => {
    const toml = read(file);
    expect(toml).toMatch(/^\[\[migrations\]\]$/m);
    // A migration entry without a tag is not applied at all.
    expect(stringValue(toml, "tag")).toMatch(/^v\d+$/);
    expect(
      [...(stringArrayValue(toml, "new_sqlite_classes") ?? [])].sort(),
    ).toEqual(DURABLE_OBJECT_CLASSES);
    expect(toml).not.toMatch(/^new_classes = /m);
  });
});

// The values that make "burn through the retries, then the DLQ" real
// live in the request Worker's config, and the delivery tuning carries
// them as declared values the constraint checks run against. They are
// exactly the kind of value a restructure drops silently.
describe("queue consumer config matches the declared delivery tuning", () => {
  it.each(REQUEST_CONFIGS)("%s", (file) => {
    const consumers = queueConsumers(read(file));
    expect(consumers).toHaveLength(2);
    const [events, dlq] = consumers;

    expect(events?.maxRetries).toBe(DELIVERY_TUNING_DEFAULTS.eventsMaxRetries);
    expect(dlq?.maxRetries).toBe(DELIVERY_TUNING_DEFAULTS.dlqMaxRetries);
    expect((events?.maxBatchTimeout ?? 0) * 1000).toBe(
      DELIVERY_TUNING_DEFAULTS.eventsMaxBatchTimeoutMs,
    );
    // `retry_delay` is left unset, and the tuning's declared counterpart
    // is the `0` that absence means. Setting one has to move the other:
    // both feed the floor under `queueMaxRetryPeriodMs`.
    expect((events?.retryDelay ?? 0) * 1000).toBe(
      DELIVERY_TUNING_DEFAULTS.eventsRetryDelayMs,
    );

    // Without a dead-letter target the retries simply stop, and the
    // DLQ half of the delivery contract disappears.
    expect(events?.deadLetterQueue).toBe(dlq?.queue);
    // A dead-letter target on the DLQ itself would loop.
    expect(dlq?.deadLetterQueue).toBeNull();
  });
});

// The DLQ's retention is a Queue-resource setting with no wrangler key,
// so the only place the real value appears in the repository is the
// `wrangler queues update` step in each deploy template's header. That
// header is therefore the observable counterpart of the declared
// `dlqRetentionMs`, and moving the declaration without it silently
// breaks both constraints `createDeliveryTuning` checks the sum against.
describe("the deploy headers set the DLQ retention the tuning declares", () => {
  it.each(REQUEST_CONFIGS.slice(1))("%s", (file) => {
    expect(retentionPeriodSecs(read(file))).toBe(
      DELIVERY_TUNING_DEFAULTS.dlqRetentionMs / 1000,
    );
  });
});

// `handleQueueBatch` picks the DLQ handler by the queue name's suffix, so
// the name minted upstream and the suffix matched downstream have to
// agree across the whole chain: Pulumi mints it, the templates carry it
// as a placeholder, and the local config spells it out.
describe("the DLQ is named the way the batch router recognises it", () => {
  it("wrangler.toml", () => {
    const [events, dlq] = queueConsumers(read("wrangler.toml"));
    expect(dlq?.queue?.endsWith(DLQ_QUEUE_SUFFIX)).toBe(true);
    expect(events?.queue?.endsWith(DLQ_QUEUE_SUFFIX)).toBe(false);
  });

  it.each(REQUEST_CONFIGS.slice(1))("%s", (file) => {
    const [events, dlq] = queueConsumers(read(file));
    // The rendered names come from the Pulumi outputs below, so what a
    // template can pin is that the two consumers read distinct outputs.
    expect(events?.queue).toMatch(/^\$\{EVENTS_QUEUE_NAME\}$/);
    expect(dlq?.queue).toMatch(/^\$\{DLQ_QUEUE_NAME\}$/);
  });

  it("the Pulumi queue resources", () => {
    const source = readRepo("infra/cloudflare/pulumi/resources/index.ts");
    const queueName = (resource: string) =>
      new RegExp(
        `new cloudflare\\.Queue\\("${resource}",[\\s\\S]*?name: \`\\$\\{prefix\\}([^\`]*)\``,
      ).exec(source)?.[1] ?? null;
    expect(queueName("dlq")?.endsWith(DLQ_QUEUE_SUFFIX)).toBe(true);
    expect(queueName("events")?.endsWith(DLQ_QUEUE_SUFFIX)).toBe(false);
  });
});

// The diagnostic route takes no authentication and makes a Durable Object
// round trip for any well-formed locator. Its whole containment is that
// the variable turning it on exists in the local config and in no
// deployed stage's.
describe("the diagnostic route is a local affordance only", () => {
  it("wrangler.toml declares it", () => {
    expect(read("wrangler.toml")).toMatch(/^DIAGNOSTICS_ENABLED = /m);
  });

  it.each(DEPLOYED_CONFIGS)("%s does not", (file) => {
    expect(read(file)).not.toMatch(/^\s*DIAGNOSTICS_ENABLED\s*=/m);
  });
});

// The development mail sink and the stub identity provider are selected
// by two variables that `.dev.vars.example` declares as local-only. Their
// whole containment is that no deployed config declares them — a
// `[vars]` entry in a template would ship the console sink (which prints
// the raw reset link) or the stub provider (which accepts any subject) to
// a real stage.
describe("the development sink and the stub provider are local affordances only", () => {
  it.each(["MAIL_DEV_SINK", "SSO_DEV_STUB"])(
    "%s is declared in .dev.vars.example",
    (name) => {
      expect(read(".dev.vars.example")).toMatch(new RegExp(`^${name}=`, "m"));
    },
  );

  it.each(
    DEPLOYED_CONFIGS.flatMap((file) =>
      ["MAIL_DEV_SINK", "SSO_DEV_STUB"].map((name) => [file, name] as const),
    ),
  )("%s does not declare %s", (file, name) => {
    expect(read(file)).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
  });
});

// The AI API's tokens, codes and client ids are all signed with one
// secret the request Worker holds (PH-07 §1.1). `.dev.vars.example` is
// where a secret's owner is declared, and a secret is never a `[vars]`
// entry: the deploy checklist in every request template names it for
// `wrangler secret put`, and no config declares it as a variable.
describe("the AI client token secret belongs to the request Worker", () => {
  it(".dev.vars.example declares it and attributes it to the request Worker", () => {
    const example = read(".dev.vars.example");
    expect(example).toMatch(/^AI_CLIENT_TOKEN_SECRET=/m);
    expect(example).toMatch(/^#\s+AI_CLIENT_TOKEN_SECRET\s+— request Worker/m);
  });

  it.each(REQUEST_CONFIGS.slice(1))(
    "%s lists it for wrangler secret put",
    (file) => {
      expect(read(file)).toContain(
        "wrangler secret put AI_CLIENT_TOKEN_SECRET",
      );
    },
  );

  it.each([...REQUEST_CONFIGS, ...STATE_CONFIGS])(
    "%s does not declare it as a variable",
    (file) => {
      expect(read(file)).not.toMatch(/^\s*AI_CLIENT_TOKEN_SECRET\s*=/m);
    },
  );
});

// The operator surface's bearer is a request-Worker secret with the same
// placement rules as the AI token secret; it is never a `[vars]` entry.
describe("the operator token belongs to the request Worker", () => {
  it(".dev.vars.example declares it and attributes it to the request Worker", () => {
    const example = read(".dev.vars.example");
    expect(example).toMatch(/^OPERATOR_TOKEN=/m);
    expect(example).toMatch(/^#\s+OPERATOR_TOKEN\s+— request Worker/m);
  });

  it.each(REQUEST_CONFIGS.slice(1))(
    "%s lists it for wrangler secret put",
    (file) => {
      expect(read(file)).toContain("wrangler secret put OPERATOR_TOKEN");
    },
  );

  it.each([...REQUEST_CONFIGS, ...STATE_CONFIGS])(
    "%s does not declare it as a variable",
    (file) => {
      expect(read(file)).not.toMatch(/^\s*OPERATOR_TOKEN\s*=/m);
    },
  );
});

// The three variables of a key rotation (`spec/rotation/index.md`, 鍵材料の
// 配布形) are secrets with a fixed owner each: the keyring on the request
// Worker, the commitment (digests, never keys) and the encryption keyring
// on the state Worker. None is ever a `[vars]` entry.
describe("the rotation variables have their declared owners", () => {
  const owners: ReadonlyArray<readonly [string, "request" | "state"]> = [
    ["DIRECTORY_ROUTING_KEYRING", "request"],
    ["DIRECTORY_KEY_COMMITMENT", "state"],
    ["IDENTITY_MAIL_ENCRYPTION_KEYRING", "state"],
  ];

  it.each(owners)(
    ".dev.vars.example declares %s for the %s Worker",
    (name, owner) => {
      const example = read(".dev.vars.example");
      expect(example).toMatch(new RegExp(`^${name}=`, "m"));
      expect(example).toMatch(
        new RegExp(`^#\\s+${name}\\s+— ${owner} Worker`, "m"),
      );
    },
  );

  it.each(owners)(
    "the deploy templates list %s for wrangler secret put against the %s config",
    (name, owner) => {
      for (const file of REQUEST_CONFIGS.slice(1)) {
        const stage = file.includes("staging") ? "staging" : "production";
        const config =
          owner === "request"
            ? `wrangler.${stage}.toml`
            : `wrangler.state.${stage}.toml`;
        expect(read(file)).toContain(
          `wrangler secret put ${name} --config ${config}`,
        );
      }
    },
  );

  it.each(
    [...REQUEST_CONFIGS, ...STATE_CONFIGS].flatMap((file) =>
      owners.map(([name]) => [file, name] as const),
    ),
  )("%s does not declare %s as a variable", (file, name) => {
    expect(read(file)).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
  });
});

// The two request-Worker `[vars]` beside the sender address are in the
// ownership table too, as non-secrets, so the table is the whole roster.
describe("the non-secret request Worker vars are in the ownership table", () => {
  it.each(["APP_URL", "DIAGNOSTICS_ENABLED"])(
    ".dev.vars.example lists %s as a [vars] entry of the request Worker",
    (name) => {
      const example = read(".dev.vars.example");
      expect(example).toMatch(
        new RegExp(
          `^#\\s+${name}\\s+— not a secret: a \\[vars\\] entry of the request Worker`,
          "m",
        ),
      );
      expect(example).not.toMatch(new RegExp(`^${name}=`, "m"));
    },
  );
});

// The sender address is what the mail provider is asked to send as, so
// every request Worker config that could reach a provider carries it as a
// `[vars]` entry, and the deployed ones read it from the Pulumi output.
describe("the request Worker configs declare the sender address", () => {
  it("wrangler.toml", () => {
    expect(stringValue(read("wrangler.toml"), "MAIL_FROM_ADDRESS")).toMatch(
      /@/,
    );
  });

  it.each(REQUEST_CONFIGS.slice(1))("%s", (file) => {
    expect(stringValue(read(file), "MAIL_FROM_ADDRESS")).toBe(
      "${MAIL_FROM_ADDRESS}",
    );
  });
});

// `vitest.config.do.ts` hand-writes the queue settings so that a batch's
// disposition in the DO suites matches what a real queue would produce.
// Nothing derives them, so this is where the copy is held to its source.
describe("the Durable Object test project mirrors the real config", () => {
  const source = readRepo("vitest.config.do.ts");

  it("queue consumers", () => {
    const mirrored = keyedEntries(objectLiteralAfter(source, "queueConsumers"));
    const real = queueConsumers(read("wrangler.toml"));
    expect(mirrored.map(([name]) => name)).toEqual(real.map((c) => c.queue));

    for (const [index, [, body]] of mirrored.entries()) {
      const expected = real[index];
      expect(jsNumber(body, "maxBatchSize")).toBe(expected?.maxBatchSize);
      expect(jsNumber(body, "maxBatchTimeout")).toBe(expected?.maxBatchTimeout);
      expect(jsNumber(body, "maxRetries")).toBe(expected?.maxRetries);
      expect(jsString(body, "deadLetterQueue")).toBe(expected?.deadLetterQueue);
    }
  });

  it("queue producer", () => {
    const producers = queueProducers(read("wrangler.state.toml"));
    expect(producers).toHaveLength(1);
    const [binding, queue] = producers[0] ?? ["", ""];
    expect(
      jsString(objectLiteralAfter(source, "queueProducers"), binding),
    ).toBe(queue);
  });

  it("Durable Objects, on the SQLite backend", () => {
    const namespaces = keyedEntries(
      objectLiteralAfter(source, "durableObjects"),
    );
    expect(
      namespaces.map(([, body]) => jsString(body, "className")).sort(),
    ).toEqual(DURABLE_OBJECT_CLASSES);
    for (const [, body] of namespaces) {
      expect(body).toMatch(/\buseSQLite:\s*true\b/);
    }
  });
});
