import { startAccountFixtures } from "./accountFixtures";

const fixtures = await startAccountFixtures({
  appUrl: process.env.FOG_FIXTURE_APP_URL ?? "http://localhost:3000",
});
console.log(
  "Local OIDC: http://127.0.0.1:3457; SMTP: 127.0.0.1:1025; mailbox: http://127.0.0.1:8025",
);
const stop = () => {
  void fixtures.close().then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
