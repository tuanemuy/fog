import { expect, it } from "vitest";
import {
  createNodeRequestContainer,
  readNodeRequestServerConfig,
  readNodeServerEnv,
} from "../serverNode";

it("normalizes the public origin and exposes only presentation dependencies", () => {
  const env = readNodeServerEnv({
    DATABASE_URL: "libsql://database.example",
    DATABASE_AUTH_TOKEN: "test-token",
    APP_URL: "https://fog.example/",
  });
  expect(env.PORT).toBe(3000);
  expect(env.HOSTNAME).toBe("127.0.0.1");
  const config = readNodeRequestServerConfig(env);
  expect(config.appUrl).toBe("https://fog.example");
  const container = createNodeRequestContainer(config);
  expect(Object.keys(container).sort()).toEqual([
    "clock",
    "config",
    "idGenerator",
    "logger",
  ]);
  expect(JSON.stringify(container.config)).not.toContain("test-token");
});
it.each([
  "https://user:password@fog.example",
  "https://fog.example/path",
  "https://fog.example?secret=x",
  "https://fog.example#fragment",
])("rejects a non-origin APP_URL %s", (APP_URL) => {
  expect(() =>
    readNodeServerEnv({ DATABASE_URL: "file:./data/app.db", APP_URL }),
  ).toThrow();
});
it.each(["0", "65536", "not-a-port"])("rejects invalid PORT %s", (PORT) => {
  expect(() =>
    readNodeServerEnv({
      DATABASE_URL: "file:./data/app.db",
      APP_URL: "http://localhost:3000",
      PORT,
    }),
  ).toThrow();
});
