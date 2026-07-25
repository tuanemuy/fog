// Single-stack layout per stage (`AppStack-staging`, `AppStack-production`).
// Mirrors the wrangler `[env.*]` pattern in CF: one declarative bundle of
// every Lambda + queue + schedule + IAM grant for one environment.
//
// Turso itself is NOT managed here — create the database with the
// `turso` CLI and pass the URL / auth-token secret ARN as stack props.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

export type AppStackProps = StackProps &
  Readonly<{
    stage: string;
    // Turso (libSQL) DB URL — passed as a Lambda env var.
    tursoUrl: string;
    // Secrets Manager ARN that holds the Turso auth token. The Lambdas
    // read it at cold start via the boot-time secrets loader.
    tursoAuthSecretArn: string;
    // Secrets Manager ARN holding the session-cookie HMAC key. Only the
    // request-path Lambda reads it; the worker Lambdas never touch a
    // session, so the secret is not distributed to them.
    sessionSecretArn: string;
    // Public origin (custom domain, or the auto-generated API Gateway URL).
    appUrl: string;
  }>;

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const tursoSecret = Secret.fromSecretCompleteArn(
      this,
      "TursoAuthTokenSecret",
      props.tursoAuthSecretArn,
    );

    const sessionSecret = Secret.fromSecretCompleteArn(
      this,
      "SessionSecret",
      props.sessionSecretArn,
    );

    // ---- SQS ---------------------------------------------------------
    const dlq = new Queue(this, "EventsDlq", {
      queueName: `${props.stage}-events-dlq`,
      retentionPeriod: Duration.days(14),
    });

    const eventsQueue = new Queue(this, "EventsQueue", {
      queueName: `${props.stage}-events`,
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // ---- Common Lambda env -------------------------------------------
    const sharedEnv: Record<string, string> = {
      DATABASE_URL: props.tursoUrl,
      DATABASE_AUTH_TOKEN_SECRET_ARN: props.tursoAuthSecretArn,
      APP_URL: props.appUrl,
      EVENTS_QUEUE_URL: eventsQueue.queueUrl,
    };

    const sharedLambdaProps = {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling: {
        externalModules: ["@aws-sdk/*"],
        target: "node22",
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        // Worker entries live under `apps/web/app/worker/aws/` and import via `@/...`
        // path aliases declared in the repo-root tsconfig. NodejsFunction's
        // esbuild bundler auto-discovers tsconfig by walking up from the
        // entry, but pinning it explicitly avoids surprises when `cdk synth`
        // is invoked from `infra/aws/` (a different working directory).
        tsconfig: path.join(repoRoot, "apps/web/tsconfig.json"),
      },
    };

    // ---- Worker Lambdas ----------------------------------------------
    // The relay Lambda is created before its env is fully known because
    // it self-invokes when it drains a saturated batch. `addEnvironment`
    // wires `RELAY_FUNCTION_NAME` after construction so the function can
    // reference its own name.
    const relayFn = new NodejsFunction(this, "RelayFn", {
      ...sharedLambdaProps,
      functionName: `${props.stage}-relay`,
      entry: path.join(repoRoot, "apps/web/app/worker/aws/relay.ts"),
      environment: { ...sharedEnv },
    });
    relayFn.addEnvironment("RELAY_FUNCTION_NAME", relayFn.functionName);

    const consumerFn = new NodejsFunction(this, "ConsumerFn", {
      ...sharedLambdaProps,
      functionName: `${props.stage}-consumer`,
      entry: path.join(repoRoot, "apps/web/app/worker/aws/consumer.ts"),
      environment: { ...sharedEnv },
    });

    const prunerFn = new NodejsFunction(this, "PrunerFn", {
      ...sharedLambdaProps,
      functionName: `${props.stage}-pruner`,
      entry: path.join(repoRoot, "apps/web/app/worker/aws/pruner.ts"),
      environment: { ...sharedEnv },
    });

    const dlqFn = new NodejsFunction(this, "DlqFn", {
      ...sharedLambdaProps,
      functionName: `${props.stage}-dlq`,
      entry: path.join(repoRoot, "apps/web/app/worker/aws/dlq.ts"),
      environment: { ...sharedEnv },
    });

    // ---- App Lambda --------------------------------------------------
    // The request-path Lambda is built by Vite (`pnpm build:aws`) into
    // `dist/server/server.aws.js` and bundled via `Code.fromAsset`. The
    // Vite output is self-contained so no NodejsFunction-style esbuild
    // pass is required.
    const appFn = new LambdaFunction(this, "AppFn", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      functionName: `${props.stage}-app`,
      handler: "server.aws.handler",
      code: Code.fromAsset(path.join(repoRoot, "apps/web/dist/server")),
      environment: {
        ...sharedEnv,
        RELAY_FUNCTION_NAME: relayFn.functionName,
        // Deliberately not in `sharedEnv`: the session key goes to the
        // request path and nowhere else. Passed as a Secrets Manager ARN
        // (same idiom as the Turso token) so the value never lands in the
        // CloudFormation template; `server.aws.ts` resolves it at cold
        // start into `SESSION_SECRET`.
        SESSION_SECRET_ARN: props.sessionSecretArn,
      },
    });

    // ---- HTTP API ----------------------------------------------------
    const api = new HttpApi(this, "AppHttpApi", {
      apiName: `${props.stage}-app-api`,
    });
    const integration = new HttpLambdaIntegration(
      "AppLambdaIntegration",
      appFn,
    );
    api.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
    });
    api.addRoutes({
      path: "/",
      methods: [HttpMethod.ANY],
      integration,
    });

    // ---- Static assets (CloudFront + S3) -----------------------------
    // Vite emits hashed client chunks to `dist/client/assets/*` and the
    // RSC manifest references them by absolute `/assets/<hash>.js`. The
    // CF runtime serves these via the wrangler `[assets]` binding; on
    // AWS the equivalent is a CloudFront distribution with two origins:
    // S3 for `/assets/*` (immutable, long-cached) and the API Gateway
    // for everything else. Without this the deployed site loads HTML
    // but every client chunk 404s.
    const clientBucket = new Bucket(this, "ClientAssetsBucket", {
      bucketName: `${props.stage}-${this.account}-client-assets`,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      ...(props.stage !== "production"
        ? { removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true }
        : {}),
    });

    new BucketDeployment(this, "ClientAssetsDeployment", {
      sources: [Source.asset(path.join(repoRoot, "apps/web/dist/client"))],
      destinationBucket: clientBucket,
      // `dist/client/` already nests under `assets/`, so deploy at the
      // bucket root and the keys land at `assets/<hash>.<ext>`.
      destinationKeyPrefix: "",
      prune: true,
    });

    const apiOrigin = new HttpOrigin(
      `${api.apiId}.execute-api.${this.region}.amazonaws.com`,
    );

    const distribution = new Distribution(this, "AppDistribution", {
      defaultBehavior: {
        origin: apiOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        // The app produces dynamic HTML / RSC payloads — bypass the cache.
        // Keep it disabled: a caching policy here would key responses
        // without the session cookie and hand one user's authenticated
        // page to the next viewer.
        cachePolicy: CachePolicy.CACHING_DISABLED,
        // CloudFront forwards only what the cache policy and the origin
        // request policy name, and `CachingDisabled` names nothing. Without
        // this the origin never sees `Cookie` (no one stays logged in) or
        // the query string (`?redirect=`, server-function arguments).
        // `Host` stays excluded so the API Gateway origin keeps resolving.
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        "/assets/*": {
          origin: S3BucketOrigin.withOriginAccessControl(clientBucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Vite-hashed filenames are immutable — long-cache safely.
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    new CfnOutput(this, "DistributionUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description:
        "Public origin of the app (set as APP_URL after first deploy)",
    });

    // ---- IAM grants --------------------------------------------------
    // Request path → relay (async invoke) + Turso auth token and session
    // secret from Secrets Manager. No SQS grant: the app never touches a
    // queue directly.
    relayFn.grantInvoke(appFn);
    // Relay self-chains when a batch saturates `maxIterations`.
    relayFn.grantInvoke(relayFn);
    tursoSecret.grantRead(appFn);
    tursoSecret.grantRead(relayFn);
    tursoSecret.grantRead(consumerFn);
    tursoSecret.grantRead(prunerFn);
    tursoSecret.grantRead(dlqFn);
    sessionSecret.grantRead(appFn);

    eventsQueue.grantSendMessages(relayFn);

    consumerFn.addEventSource(
      new SqsEventSource(eventsQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        reportBatchItemFailures: true,
      }),
    );

    // `reportBatchItemFailures` is left off intentionally: the handler always
    // acks every message, because the DLQ has no further dead-letter target
    // and a re-failure would loop.
    dlqFn.addEventSource(
      new SqsEventSource(dlq, {
        batchSize: 10,
      }),
    );

    // ---- Schedules ---------------------------------------------------
    new Schedule(this, "RelaySafetyNetSchedule", {
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(relayFn, {}),
      description: "Safety-net relay tick (5 min) — covers async-invoke misses",
    });

    new Schedule(this, "PrunerDailySchedule", {
      schedule: ScheduleExpression.cron({
        minute: "0",
        hour: "3",
      }),
      target: new LambdaInvoke(prunerFn, {}),
      description: "Daily outbox pruning at 03:00 UTC",
    });

    // Stage-scoped removal policy: never auto-destroy production data.
    if (props.stage !== "production") {
      eventsQueue.applyRemovalPolicy(RemovalPolicy.DESTROY);
      dlq.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
  }
}
