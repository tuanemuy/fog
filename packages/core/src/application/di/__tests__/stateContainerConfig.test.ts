import { describe, expect, it } from "vitest";
import {
  createIdentityDirectoryContainer,
  createUserDataContainer,
  readStateSecrets,
  type StateEnv,
} from "../stateCloudflare";

// The state Worker's twin of `requestContainerConfig.test.ts`. Nothing on this
// side reaches a browser, but the same shape rule holds for the same reason: a
// secret placed flat on a container rides every spread of it, and the next
// thing to spread a container is the thing that logs it.
const MAIL_KEY = "mail-encryption-0123456789abcdef0123";
const RESET_KEY = "reset-token-0123456789abcdef01234567";

const ENV: StateEnv = {
  USER_DATA: {} as never,
  IDENTITY_DIRECTORY: {} as never,
  APP_URL: "http://localhost:8787",
  IDENTITY_MAIL_ENCRYPTION_KEY: JSON.stringify([
    { generation: 1, key: MAIL_KEY },
  ]),
  IDENTITY_RESET_TOKEN_KEY: JSON.stringify([{ generation: 1, key: RESET_KEY }]),
};

// `transactionSync` is never called here — the containers only retain the
// handle — so a stub with a `storage.sql` slot is enough to build one.
const CTX = { storage: { sql: {} } } as never;

const containers = [
  ["user data", () => createUserDataContainer(CTX, ENV)],
  ["identity directory", () => createIdentityDirectoryContainer(CTX, ENV)],
] as const;

describe.each(containers)("%s container", (_name, build) => {
  it.each([MAIL_KEY, RESET_KEY])(
    "carries no state secret on the container",
    (secret) => {
      const container = build() as Record<string, unknown>;
      const visible = Object.entries(container)
        .filter(([, value]) => typeof value === "string")
        .map(([, value]) => value as string)
        .join("\n");
      expect(visible).not.toContain(secret);
      expect(Object.keys(container)).not.toContain("mailEncryptionKeyring");
      expect(Object.keys(container)).not.toContain("resetTokenKeyring");
    },
  );
});

describe("readStateSecrets", () => {
  it("parses both keyrings", () => {
    const secrets = readStateSecrets(ENV);
    expect(secrets.mailEncryptionKeyring.entries).toHaveLength(1);
    expect(secrets.resetTokenKeyring.entries).toHaveLength(1);
  });

  it.each([
    "IDENTITY_MAIL_ENCRYPTION_KEY",
    "IDENTITY_RESET_TOKEN_KEY",
  ] as const)("refuses an unset %s", (name) => {
    expect(() => readStateSecrets({ ...ENV, [name]: undefined })).toThrow(
      new RegExp(name),
    );
  });
});

// Unlike the request side, an unset optional binding must not stop a Durable
// Object from being constructed: the constructor runs before every entry point,
// so throwing there would take out `alarm()` and the operator diagnostics too.
describe("a state container with no optional bindings", () => {
  it("still builds", () => {
    const bare: StateEnv = {
      USER_DATA: {} as never,
      IDENTITY_DIRECTORY: {} as never,
      APP_URL: "http://localhost:8787",
    };
    expect(() => createIdentityDirectoryContainer(CTX, bare)).not.toThrow();
  });
});
