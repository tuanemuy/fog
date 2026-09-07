import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const zoneName = config.require("zoneName");
const appHostname = config.require("appHostname");
const appUrl = config.require("appUrl");
const prefix = config.require("resourcePrefix");

const zone = new cloudflare.Zone("zone", {
  accountId,
  zone: zoneName,
});

const db = new cloudflare.D1Database(
  "db",
  {
    accountId,
    name: `${prefix}-d1`,
  },
  // D1 is the system of record — refuse accidental destroy.
  { protect: true },
);

// The Queue carries event delivery and nothing else: it is the transport
// between the Outbox relay (inside each Durable Object's `alarm()`) and
// the consumers hosted in the request Worker. It is never a store and
// never a work distributor.
const eventsQueue = new cloudflare.Queue("events", {
  accountId,
  name: `${prefix}-events`,
});

// `message_retention_period` cannot be set from here: `QueueArgs` takes
// `accountId` and `name` only, and the retention is a Queue-resource
// setting reachable through `wrangler queues create/update
// --message-retention-period-secs`. It is therefore an out-of-band
// operational step (see the "Before first deploy" list in the `.tpl`s),
// and `application/delivery/tuning.ts` carries it as a declared value the
// constraint checks run against.
const dlqQueue = new cloudflare.Queue("dlq", {
  accountId,
  name: `${prefix}-events-dlq`,
});

export const zoneId = zone.id;
export const databaseId = db.id;
export const databaseName = db.name;
export const eventsQueueName = eventsQueue.name;
export const dlqQueueName = dlqQueue.name;
export const exportedAppUrl = appUrl;
export const exportedAppHostname = appHostname;
export const exportedPrefix = prefix;
