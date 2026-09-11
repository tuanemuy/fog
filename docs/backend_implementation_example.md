# Backend Implementation Guide

The snippets use a `Foo` domain — a placeholder for the aggregate you are adding. Each domain is laid out as `packages/core/src/domain/${domain}/` plus `packages/core/src/application/${domain}/`; follow that structure when adding one.

> For principles and abstract concepts, see `CLAUDE.md`. This document is a collection of copy-and-adapt patterns for "how to actually write the code".

## File Layout

```
packages/core/src/
├── domain/
│   ├── common/
│   │   ├── event.ts                   EventId, DomainEventBase, EventDraft, WithEventDrafts
│   │   ├── transactionalRepository.ts TransactionalRepository, ExpectedVersion, Versioned
│   │   ├── version.ts                 Version (branded non-negative integer)
│   │   ├── pagination.ts
│   │   └── text.ts
│   ├── error.ts                       BusinessRuleError, RehydrationError
│   └── ${domain}/                     identity, memo, knowledge, search, trash, export
│       ├── entity.ts
│       ├── valueObject.ts
│       ├── errorCode.ts
│       ├── ${eventType}.ts            one file per event type: type constant + payload + draft factory
│       └── ports/                     the repository / store ports (synchronous; see "Repository Port")
├── application/
│   ├── delivery/
│   │   ├── types.ts                   jobs.kind rosters + per-kind policy, RPC envelope types
│   │   └── tuning.ts                  DeliveryTuning + createDeliveryTuning (declared operating values)
│   ├── di/
│   │   ├── types.ts                   SharedDeps, RequestContainer, AppConfig
│   │   ├── containerStore.ts          installContainerStore, getContainer
│   │   ├── secrets.ts                 requireSessionSecret, requireDirectoryRoutingKeyring, …
│   │   ├── serverCloudflare.ts        createRequestContainer, createQueueContainer, readRequestServerConfig
│   │   └── aiToolContainer.ts         the AI API's narrowed container (no gateway reachable from a tool)
│   ├── execution/
│   │   └── unitOfWork.ts              the canonical (synchronous) UoW contract + one context per DO class
│   ├── ports/                         clock, idGenerator, logger, tokenGenerator (synchronous);
│   │                                  mailSender, sessionCodec, ssoIdentityProvider, aiTokenCodec (asynchronous)
│   ├── errors.ts                      NotFound / Conflict / Validation / Unauthorized / Forbidden / System
│   ├── types.ts                       UsecaseContainer, ServiceArgs<T>
│   └── ${domain}/
│       ├── gateway.ts                 the request side's port into the Durable Objects (DTOs, primitives)
│       ├── view.ts
│       ├── ${usecase}.ts              the usecase + the `*Procedure` the DO runs (see "Gateway and procedure")
│       └── __tests__/
└── adapters/
    ├── cloudflare/
    │   ├── durableObjectBase.ts       AsyncWorkDurableObject: RPC envelope, schema gate, alarm(), operator entries
    │   ├── userDataDurableObject.ts   one user's data
    │   ├── identityDirectoryDurableObject.ts  one credential bucket
    │   ├── unitOfWork.ts              the DO providers, wrapping storage.transactionSync
    │   ├── stores/                    one module per table or projection: the aggregate repositories
    │   │                              (memo / topic / document / userSettings / aiClientConnection), the
    │   │                              non-aggregate stores (jobWriter, outboxWriter, operationsStore,
    │   │                              credentialLocatorStore, credentialMappingStore, passwordResetTokenStore,
    │   │                              resetRequestWindowStore, rotationCheckpointStore, migrationProgressStore,
    │   │                              accountStore), the search index / projection / cursor / snippet,
    │   │                              sendMailMaterials, exportSourceReader, occ, bindChunks, oauthConsumedCodes
    │   ├── schema/                    plan.ts + one migration plan per DO class
    │   ├── migrationGate.ts           the fail-closed schema gate
    │   ├── rowRunner.ts               claim / release / finalize / prune + failureLabel, shared by both runners
    │   ├── jobRunner.ts               the local-job pass, terminal mode, the prune pass
    │   ├── jobs/                      one handler per jobs.kind (11) + cleanup/ (the roll-back stages)
    │   ├── outboxRelay.ts             the relay pass (claim → publish → finalize)
    │   ├── alarmSchedule.ts           rearm(): the earliest wake-up over both tables
    │   ├── doStubs.ts                 stub selection + callDurableObject (envelope unwrapping)
    │   ├── identityGateway.ts, memoGateway.ts, knowledgeGateway.ts, searchGateway.ts,
    │   │   trashGateway.ts, exportGateway.ts   the usecases' entry to the DO classes
    │   ├── rotation/                  remapChunk, importRemappedMappings, mappingRows (the mapping-key transfer)
    │   ├── crypto/                    keyring.ts, locatorDerivation.ts, canonicalCipher.ts
    │   └── terminalReason.ts, queueMessage.ts, payloadDigest.ts, rpcErrors.ts, notFound.ts
    ├── mail/                          consoleMailSender, resendMailSender, resetMailContent
    ├── sso/                           devStubSsoProvider, googleSsoProvider
    ├── fflate/zipArchiveWriter.ts
    └── webcrypto/                     pbkdf2PasswordHasher, hmacSessionCodec, aiTokenCodec, ssoStateCodec,
                                       webCryptoTokenGenerator, derivedHmac, encoding

packages/core/src/lib/
├── error.ts                       CodedError base (identity brand + isCodedError / hasSerializedKind) + SerializedErrorBase / FieldErrors / SerializableError interface (structure only; the union is assembled in presentation)
└── text.ts

apps/web/app/
├── presentation/
│   ├── errorResponse.ts           AppServerError, serializeError, extractSerializedError, asSerializedError, isAppServerError, redactForClient, httpStatusFor
│   ├── errorResponseMiddleware.ts errorResponseMiddleware (wraps inputValidator + handler)
│   ├── errorDisplay.ts            displayError, sanitizeRouteError
│   ├── serverAction.ts            loadServerDeps, serverData — internal-only, intentionally schemaless
│   ├── serverFnResult.ts          readServerFnResult — the client-side shape check on a server function's answer
│   ├── validator.ts               validateInput(schema) — transport-boundary shape check
│   ├── currentUser.ts, session.ts, sessionCookie.ts, requestSession.ts, authState.ts
│   ├── streamingRoute.ts, head.ts, time.ts, pagination.ts, redirectSearch.ts, diff.ts
│   ├── ai/                        the OAuth 2.1 / MCP / REST handlers (the token codec arrives from the entry point; pkce.ts is RFC 7636)
│   └── export/                    the POST /export handler (the archive writer arrives from the entry point)
├── worker/cloudflare/
│   ├── state.ts                   state Worker entry: re-exports the two Durable Object classes
│   ├── queueHandlers.ts           mail consumer + DLQ handler, hosted by the request Worker
│   ├── operatorHandlers.ts        POST /__operator/<entry>: the 15 maintenance entries behind OPERATOR_TOKEN
│   └── ssoHandlers.ts, diagnostics.ts, stateEnv.check.ts
└── scripts/                       operator.ts (the maintenance CLI), ai-client.ts (the OAuth / MCP test client), render-wrangler.ts
```

## Domain Layer

### Value Object

```ts
declare const fooIdBrand: unique symbol;
export type FooId = string & { readonly [fooIdBrand]: true };

export const FooId = {
  create: (raw: string): FooId => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(FooErrorCode.InvalidId, "Invalid foo id");
    }
    return trimmed as FooId;
  },
};
```

Key points:

- `unique symbol` for nominal typing
- the factory is the only creation path
- invalid values throw `BusinessRuleError` (the Result type is not used)
- **do not add `generate()`**. id generation goes through the `IdGenerator` port in the application layer
- domain treats the id as an "opaque non-empty string". The format (UUIDv7 / ULID / KSUID, etc.) is the responsibility of the `IdGenerator` implementation, and the storage adapter re-validates it with `IdGenerator.validate(id)` at rehydration time. Putting generation and validation behind the same port means that when you swap the generator, the validator switches over in pair automatically, letting you swap the format without touching the VO
- the OCC counter is a value object too — `Version` (`packages/core/src/domain/common/version.ts`), with `Version.initial()` / `Version.next(v)` / `Version.create(raw)`. Entities never do raw arithmetic on it

### Entity

```ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (
    params: { id: string; /* ...domain inputs... */ },
    now: Date,
  ): ActiveFoo => ({
    ...params,
    id: FooId.create(params.id),
    status: "active",
    version: Version.initial(),
    createdAt: now,
    updatedAt: now,
  }),

  complete: (foo: ActiveFoo, now: Date): CompletedFoo => ({
    ...foo,
    status: "completed",
    version: Version.next(foo.version),
    updatedAt: now,
  }),
};
```

Key points:

- represent state with a discriminated union → invalid transitions become type errors
- **VO construction is concentrated in the entity factory** (the application layer passes `id` as a raw string)
- take `now: Date` and the required `id` as arguments (domain never calls `new Date()` or `uuidv7()`)
- a transition that also emits events returns `WithEventDrafts<TEntity, TEvent>` — `{ entity, eventDrafts }` — and the caller hands `eventDrafts` to `enqueueEvent` inside the same unit of work that persists `entity`. The drafts are **identity-less**: the `EventId` is minted by the unit-of-work implementation, never by the domain
- for operations with no successor entity, such as deletion, do not put a method on the domain; the usecase builds the draft with the domain's draft factory directly
- a transition that changes nothing should return the argument unchanged rather than bump the version — `User.changeTrashRetentionDays` does exactly that, so a settings form re-posting its current value does not fight concurrent writers over OCC

### Domain Event

One file per event type, in the domain layer, carrying the `type` constant, the payload type, the event type and the draft factory. `packages/core/src/domain/identity/passwordResetRequested.ts` is the shipped example.

```ts
// packages/core/src/domain/foo/fooArchived.ts
import type {
  DomainEventBase,
  EventDraft,
} from "@repo/core/domain/common/event";
import type { FooId } from "./valueObject";

export const FOO_ARCHIVED = "foo.archived";

export type FooArchivedPayload = Readonly<{ fooId: string }>;

export type FooArchivedEvent = DomainEventBase<
  typeof FOO_ARCHIVED,
  FooArchivedPayload
>;

export function fooArchivedDraft(
  fooId: FooId,
  occurredAt: Date,
): EventDraft<FooArchivedEvent> {
  return {
    type: FOO_ARCHIVED,
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  };
}
```

Key points:

- **the module is the single point of definition for the `type` string.** It lives in the domain because the factory that decides the `type`, the `aggregateId` and the payload shape is a domain artefact; putting the constant in the application layer would make the factory import application code and invert the dependency direction. Adapters (the relay, the consumer's routing) import it from here, which is inward and therefore legal
- **the roster of every `event.type` and every `jobs.kind` lives in exactly one place, `spec/async/index.md`.** Adding one means answering which of the three classification rules it matched and adding one row to that table — nowhere else names it
- the factory returns an **identity-less draft**. `EventId` is minted inside the unit of work from the `IdGenerator` port, which keeps id generation out of domain-function arguments and in the single UoW adapter
- **the payload carries neither PII nor a reusable secret.** It is persisted for the PITR retention window and copied verbatim into the queue message. Delivery material that must never be persisted (a recipient, a raw token) is fetched by the consumer through an RPC back into the emitting DO at send time
- **there is no decoder and no decoder registry.** Nothing rehydrates an outbox row back into a domain event: the relay copies `payload` through as-is, and the consumer routes on `type` and calls back into the emitting DO for every judgement. What type-checks a draft against the domain payload type is the `TEvent` binding on the unit-of-work context (below), not a decode step

## Application Layer

### Registering side effects

The unit-of-work context is the only write path for the effects an operation produces beyond its own business write. Two registration points exist on **every** DO class:

```ts
export interface CommonUnitOfWorkContext<
  TKind extends string,
  TEvent extends DomainEvent = never,
> {
  enqueueJob(input: EnqueueJobInput<TKind>): void;
  enqueueEvent(drafts: readonly EventDraft<TEvent>[]): void;
}
```

Everything else on a context differs by DO class (`spec/database/index.md` declares the roster per class — eight non-aggregate stores, nine methods, plus the aggregate repositories):

- `UserDataUnitOfWorkContext` adds the four aggregate repositories (`userSettingsRepository` / `memoRepository` / `topicRepository` / `documentRepository`), `aiClientConnectionRepository`, `accountStore`, `credentialLocatorStore`, the read-only `searchIndex` and `trashQueryPort`, and three registration points: `recordOperation` / `updateOperation` (`operations`) and `setMigrationCursor` (`migration_progress`). Its event roster is empty, so `TEvent` stays `never`
- `IdentityDirectoryUnitOfWorkContext` adds `credentialMappingReader` / `credentialMappingWriter` / `credentialAttemptRecorder` (the only ways `credential_mappings` is read and written), `resetTokenStore`, `resetThrottleStore` and `rotationCheckpointStore`, and binds `TEvent` to `PasswordResetRequestedEvent`

The search projection is on neither: it is maintained inside the writing repository's own statement, in the same `transactionSync`, and is not injectable.

Key points:

- **which mechanism carries an effect is decided by who owns its completion** — synchronous execution in the same transaction, an Outbox event, or a local job, in that order (`CLAUDE.md`, "Asynchronous execution contract")
- `TKind` binds `enqueueJob` to the `jobs.kind` union its DO class may write, and `TEvent` binds `enqueueEvent` to the **event types** — not to their `type` strings — so a draft is measured against the domain's payload type. `TEvent` defaults to `never`, which makes a draft unconstructable and leaves `[]` as the only accepted argument: that is how a class with an empty event roster says so in the type
- `EnqueueJobInput.operationKey` is derived deterministically by the caller — it is the job's identity, and re-submissions converge onto the existing row — so it never comes from `IdGenerator` and never from the client
- both points write into the DO's own tables inside the same `transactionSync` as the business write, so a rollback unwinds them together with it

### Usecase

A usecase that mutates state runs its whole write inside one `run(fn)`, and **the callback is synchronous** — the signature type-rejects an `async` callback. Write the body as a plain function over the context, and let the DO entry hand it over (`this.runUnitOfWork((ctx) => beginSignup(ctx, operationId, now))`). The snippet is illustrative — it type-checks against `EnqueueJobInput`, but the shipped registration does not look like this: the reservation is written on the Identity Directory side by `reserveCredentialProcedure` (`packages/core/src/application/identity/reserveSignupCredential.ts`), which seeds `sweep-reservations` and, for the coordinator row, `resume-signup` in the same transaction as the mapping row; `initializeAccount` on the User Data side records the `signup` operation and seeds nothing.

```ts
export function beginSignup(
  ctx: UserDataUnitOfWorkContext,
  operationId: string,
  now: Date,
): void {
  ctx.recordOperation({
    operationId,
    kind: "signup",
    payload: { step: "reserved" },
    phase: "reserved",
  });
  ctx.enqueueJob({
    operationKey: `resume-link:${operationId}`,
    kind: "resume-link",
    payload: { operationId },
    nextRunAt: new Date(now.getTime() + 60_000),
  });
}
```

Key points:

- resolve `now` / `id` at the top of the caller, from the `Clock` / `IdGenerator` ports. The `EventId` is minted by the unit of work, so the caller does not have to care
- there are four VO-construction sites: the entity factory, the lookup-key construction at the top of a mutate/delete usecase (`FooId.create(input.id)`), adapter rehydration, and rebuilding a primitive that crossed the DO or queue boundary (`Email.create(materials.to)` in the mail consumer)
- **never `await` inside the callback, and never call `run` from inside `run`.** Anything asynchronous — hashing, mail, a DO stub call — happens before or after, never within
- the return value handed to the presentation layer is a DTO projected by a helper in `view.ts`. Type its fields as primitives, never branded VOs — brands widen to their primitive for free, so projection stays cast-free
- there is intentionally no generic utility for OCC retry. `ConflictError("OPTIMISTIC_LOCK_FAILURE")` propagates straight to the caller

Request-path usecases (`registerWithPassword` / `loginWithPassword` / `postMemo` / `unlinkSsoCredential` are examples) open no unit of work of their own: their state lives in Durable Objects, so they call in through a gateway and the unit of work runs on the far side of that call. Read `registerWithPassword` for the `ServiceArgs<T>` shape, the "hash before the unit of work opens" rule and the shape of a saga that spans two objects; read the contract above for what a usecase inside one object looks like.

### Gateway and procedure

Every usecase file holds two halves of one operation, and the layering between them is the same for every domain:

1. **the usecase** (request side, `async`) takes `ServiceArgs<TInput>`, resolves what only the request side can (a password hash, a locator derived with the mapping keyring, the caller's session), and calls one method on the domain's gateway with primitives
2. **the gateway** (`application/${domain}/gateway.ts` is the port; `adapters/cloudflare/${domain}Gateway.ts` implements it) selects the Durable Object stub and unwraps the RPC envelope with `callDurableObject`
3. **the DO facade** (`userDataDurableObject.ts` / `identityDirectoryDurableObject.ts`) resolves `id` / `now` from the DO's own ports and runs the procedure: `this.envelope(() => this.runUnitOfWork((ctx) => fooProcedure(ctx, dto, id, now)))`
4. **the procedure** (`fooProcedure`, exported next to the usecase in `application/${domain}/foo.ts`) is a pure synchronous function over the unit-of-work context: it rebuilds the value objects from the DTO, calls the domain, writes through the context, and returns a view

`postMemo` is the shipped example: `postMemo()` in `application/memo/postMemo.ts` calls `container.memoGateway.postMemo(userId, { body, actor })`; `createMemoGateway` in `adapters/cloudflare/memoGateway.ts` does `callDurableObject(() => userData(userId).postMemo(input))`; `UserDataDurableObject.postMemo` mints the id, reads the clock and its own locator, and runs `postMemoProcedure(ctx, { ...input, userId }, id, now)`, which builds the `Memo` aggregate, inserts it and its first revision through `ctx.memoRepository` (the search projection rides in that repository's statement) and returns `toMemoView(memo)`.

Job handlers reuse the same procedures: `sweep-orphan-mapping` closes an unlink record with `finishUnlinkProcedure`, the same function the request-path `unlinkSsoCredential` reaches through `finishUnlink`. A procedure therefore has two callers — the RPC entry and the Alarm — and belongs to neither.

### Container Wiring

Provide the container as **one type per scope**, mixing in `SharedDeps` (`clock` / `idGenerator` / `logger`) by intersection, so each scope holds only the fields that scope needs.

```ts
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;

// Request path: usecases that mutate aggregates + SSR head/meta.
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    identityGateway: IdentityGateway;
    identityTuning: IdentityTuning;
    memoGateway: MemoGateway;
    knowledgeGateway: KnowledgeGateway;
    searchGateway: SearchGateway;
    trashGateway: TrashGateway;
    exportGateway: ExportGateway;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
    tokenGenerator: TokenGenerator;
  }>;

// The `queue()` handlers: the mail consumer and the DLQ handler
// (`di/serverCloudflare.ts`; it names a platform type, so it lives there).
export type QueueContainer = Readonly<{
  mailSender: MailSender;
  logger: Logger;
  bindings: DurableObjectBindings;
}>;
```

```ts
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer { /* ...six gateways + tuning + AppConfig + hasher + codec + token generator... */ }

export function createQueueContainer(env: ServerEnv): QueueContainer {
  /* ...DO bindings + the mail sink (console sink locally, the provider otherwise)... */
}
```

Key points:

- **repositories stay off the container.** The unit-of-work context is their single point of issue, which is what keeps every aggregate access inside a unit of work. `passwordHasher` is a deliberate exception: it is a domain port but not a repository, it touches no storage, and hashing must happen *before* the unit of work opens so a CPU-bound derivation never sits inside a transaction
- a container whose shape names a platform type (`DurableObjectNamespace`) belongs in the composition root `di/serverCloudflare.ts`, not in the layer-neutral `di/types.ts` that presentation and application code both import
- **`QueueContainer` holds no repository, no unit of work and no processed-events store.** A consumer makes no business judgement, and idempotency is declared per consumer — this one keeps no key at all. The delivery tuning it needs is held by the Durable Objects, not by the consumer
- `createDeliveryTuning()` / `createIdentityTuning()` validate the constraints between the declared operating values, and construction — not module scope — is where that failure surfaces
- `sessionCodec` is presentation-only: usecases receive `UsecaseContainer`, which omits it. `tokenGenerator` mints the opaque secrets the request side owns (caller bindings, reset tokens, code `jti`s)
- consolidate the path that reads request-side env into `readRequestServerConfig()`

## Adapter Layer

### Repository Port

The base contract including OCC is consolidated in `TransactionalRepository<TEntity, TId>` (`packages/core/src/domain/common/transactionalRepository.ts`). Each aggregate's port extends it and only adds read-only queries:

```ts
export interface FooRepository extends TransactionalRepository<Foo, FooId> {
  findPage(pagination: Pagination): PaginationResult<Foo>;
}
```

What `TransactionalRepository<TEntity, TId>` provides — **every method returns a value, never a promise**, because the unit of work is a single `transactionSync` that cannot await; the read-only queries a concrete port adds are synchronous for the same reason:

```ts
interface TransactionalRepository<TEntity, TId = string> {
  insert(entity: TEntity): void;
  findById(id: TId): Versioned<TEntity> | null;
  save(entity: TEntity, expectedVersion: ExpectedVersion<TEntity>): void;
  delete(id: TId, expectedVersion: ExpectedVersion<TEntity>): void;
}

type Versioned<T> = { readonly entity: T; readonly expectedVersion: ExpectedVersion<T> };
type ExpectedVersion<T> = number & { readonly [brand]: T };  // phantom T
```

Bind `TId` to the branded `FooId`, not the raw `string` default. The lookup key is then a value object: the usecase constructs it via `FooId.create(input.id)` at its boundary — before the lookup — so the id-format invariant is checked in one place and is no longer duplicated against the transport-layer schema. Binding `TId` also makes a foreign id (a `BarId` passed to a `Foo` repository) a type error.

OCC is enforced at the type level with the `ExpectedVersion<Foo>` token:

- only `findById` is the legitimate token-issuing point (a single `as` cast inside the adapter)
- `save` / `delete` take the token as a required argument → "writing without reading" is a type error
- `insert` is exclusively for initial persistence. Since no version exists yet, no OCC token is needed
- read-only queries like `findPage` are defined separately on the concrete port

Thanks to the phantom `T`, `ExpectedVersion<Foo>` and `ExpectedVersion<Bar>` are type-incompatible → **mixing up tokens between aggregates is a type error**. This severs the implicit connection of "the domain function bumps the version → the adapter recomputes `entity.version - 1`", giving a contract where the version observed at read time is carried straight through to the write.

Adding an aggregate is two edits: one slot line on the context of the DO class that owns it (`packages/core/src/application/execution/unitOfWork.ts`), and the construction of the repository in that class's provider (`packages/core/src/adapters/cloudflare/unitOfWork.ts`).

### Repository (OCC implementation)

The OCC write is a conditional `UPDATE` guarded on `id` **and** `version`, whose matched-row count is read back. `createUserSettingsRepository` (`packages/core/src/adapters/cloudflare/stores/userSettingsRepository.ts`) is the shipped one; `user_settings` is single-row, so `version` alone conditions it and there is no `id` predicate to add:

```ts
save: (user, expectedVersion) => {
  const matched = updateMatchedRow(
    sql,
    `UPDATE user_settings
     SET trash_retention_days = ?, version = ?, updated_at = ?
     WHERE version = ?`,
    user.trashRetentionDays,
    user.version,
    now,
    expectedVersion as number,
  );
  if (!matched) {
    // The message reaches the client as-is (`redactForClient` passes
    // `conflict` through), so it must not carry the user id or the
    // expected version.
    throw new ConflictError(
      "OPTIMISTIC_LOCK_FAILURE",
      "Optimistic lock failure: the user was modified concurrently",
    );
  }
},
```

Key points:

- **the token, not the entity, supplies the expected version.** `expectedVersion as number` is the only place the brand is stripped; the in-memory entity has already been bumped by the domain transition, so re-deriving `entity.version - 1` would be the bug the token exists to prevent
- a 0-row update → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`, which travels to the transport boundary unswallowed — there is no retry at any level in between. Single-row tables have no `id`, so `version` alone conditions them (`spec/database/index.md` is the authority on the per-table form). **Only a writer that holds its token across a transaction boundary can match 0 rows**: a path that reads and writes inside one `run` never can, because the unit of work is a single transaction
- the conflict message must carry no identifiers: `conflict` is one of the kinds `redactForClient` passes through verbatim
- driver exceptions are translated at the unit-of-work boundary, not per store: `translate()` in `packages/core/src/adapters/cloudflare/unitOfWork.ts` catches whatever escapes `transactionSync`, passes `CodedError`s through, turns a `RehydrationError` into `SystemError(DataIntegrityError)` and everything else into `SystemError(DatabaseError)`. Application code never sees a provider-native error
- rehydration is a `try / catch` around the value-object constructors that throws `RehydrationError` (`rehydrate()` in `stores/memoRepository.ts` is the shape); the translation above is what turns it into the `DataIntegrityError` the caller sees
- do not use upsert (`ON CONFLICT DO UPDATE`) — it would hide lost updates

### Unit of Work

`packages/core/src/adapters/cloudflare/unitOfWork.ts` implements `UnitOfWorkProvider.run(fn)` for both DO classes:

1. `run` wraps `ctx.storage.transactionSync`, so the business write, any FTS5 projection and the rows appended by `enqueueJob` / `enqueueEvent` land in one transaction and a rollback unwinds all of them together
2. the callback is synchronous by type, which is what makes that true — one `await` inside would break the transaction's atomicity
3. one transaction per unit of work means operations inside a DO are fully serialized, so a usecase that reads and writes inside one `run` never conflicts with a concurrent one — OCC bites only a writer that holds its `version` token across a transaction boundary
4. `enqueueEvent` mints the `EventId` from the `IdGenerator` port and writes one `outbox_events` row per draft, in its own statement (batching would have to stay under the 100 bind-parameter ceiling)
5. both registration points raise a re-arm flag, which `takeRearmRequest()` hands to the caller **after** `run` has returned; `setAlarm()` is asynchronous and cannot be issued from inside `transactionSync`
6. when `transactionSync` throws, the flag is cleared again — the rows rolled back, so nothing should be woken for them

There is no second provider: `UnitOfWorkProvider` — synchronous, `async`-rejecting — is the only unit-of-work contract in the repository, and the SQLite-backed Durable Object storage is the only storage adapter.

### Durable Object entry points

Both DO classes extend `AsyncWorkDurableObject` (`packages/core/src/adapters/cloudflare/durableObjectBase.ts`), which owns the four things every entry shares:

```ts
async someEntry(arg: string): Promise<RpcEnvelope<Result>> {
  return this.envelope(async () => {
    await this.enterRpc();
    return this.runUnitOfWork((ctx) => {
      /* ...synchronous business write + enqueueJob / enqueueEvent... */
    });
  });
}
```

Key points:

- **`envelope` is the catch boundary.** Errors cross the request Worker ↔ DO boundary as a value envelope (`{ ok: true, value } | { ok: false, error }`), never as a thrown custom class: RPC does not preserve the structural serialization contract the guards depend on. The calling side unwraps it with `callDurableObject`, which additionally translates a failure of the stub call itself (the DO was unreachable or died) — those never enter the envelope
- **what the envelope carries about an unclassified failure is a code-owned projection**, taken from the same `failureLabel` the runners write to `terminal_reason`. The thrown value's own `message` is never taken: a provider SDK puts the rejected request — recipient and raw token — in it, and this value reaches the request Worker's logger un-redacted
- **`enterRpc` runs at the head of every entry**: resolve the DO's own locator, build the tuning, pass the fail-closed schema gate, and arm the Alarm if the gate seeded job rows. The diagnostic entries — `readSchemaVersion` among them — sit outside it on purpose, so an uninitialised DO can be reported as uninitialised instead of being created
- **`runUnitOfWork` is the only place a unit of work is run and the Alarm re-armed afterwards.** Route usecase entries through it rather than calling `provider.run` and writing your own re-arm, or the rule "whoever added a runnable row arms the Alarm" splits per path
- facade signatures take **primitives only** — branded types do not survive structured clone — and the value objects are rebuilt inside the DO. That reconstruction *is* the value-object validation point; the RPC hop is not a third one
- **the base class also carries the operator entries every class shares**: `readSchemaVersion` (outside the gate), `readDeliveryBacklog`, `listQuarantinedEvents` / `requeueQuarantinedEvent` / `deleteQuarantinedEvent`, `listPoisonedJobs` / `requeuePoisonedJob` / `deletePoisonedJob`. The Identity Directory adds `purgeUserMappings`, `listBucketUserIds` (outside the gate), `startRotateEncryption`, `remapChunk`, `importRemappedMappings`, `readRotationCheckpoint`; the User Data object adds `recordRemappedLocator`. All 15 are reached through `POST /__operator/<entry>` (`apps/web/app/worker/cloudflare/operatorHandlers.ts`, behind `OPERATOR_TOKEN`) and never through a gateway; `requeue-*` and `start-rotate-encryption` re-arm the Alarm, the reads and `delete-*` do not

### The Alarm

A DO has one Alarm and it multiplexes both tables. `alarm()` runs a fixed order: (1) re-arm and confirm persistence, (2) the schema gate, (3-a) the relay pass, (3-b) the jobs pass, then the prune, (4) recompute the earliest wake-up from both tables and re-arm.

Key points:

- **it never throws.** Each step is wrapped so that one failing step neither aborts the wake-up nor escapes `alarm()`. Retry belongs to the job runner and to the relay, not to the platform
- the relay pass and the job pass each run exactly once per wake-up, under **count limits held independently per pass**, so a backlog in one cannot starve the other
- `rearm()` takes the earliest of what either table asks for — `pending` rows by `next_run_at` **and leased rows by `lease_until`** — and calls `deleteAlarm()` only when both runnable sets are empty
- **the fail-closed path at (2) does not delete the Alarm.** It arms a fixed interval (no backoff — a fail-closed DO characteristically holds `pending` rows whose `next_run_at` is in the past, and arming that would spin) and returns, so a DO running behind its code recovers on the next wake-up once the deploy catches up

### Job handler

A local job is the mechanism for an effect whose completion a specific DO or saga coordinator owns. Adding one:

1. add the kind to its DO class's union in `packages/core/src/application/delivery/types.ts` and declare its two convergence properties in `JOB_KIND_POLICY` — the dictionary is total, so a new kind that is not declared fails to type-check
2. add the row to the roster in `spec/async/index.md`
3. register a handler in the DO's `JobHandlerRegistry`

```ts
const handler: JobHandler = async ({ storage, payload, now, tuning }) => {
  // ...one chunk of work...
  return { kind: "finished" };
};
```

Key points:

- a handler returns `finished`, `rearm` (work remains — go back to `pending` at `nextRunAt`), `yield` (the chunk-iteration ceiling was hit — release the lease and continue later) or `poison` (a roll-back stage found its material gone — `cleanup-material-lost:*` whatever `attempt` says). `finished` and `yield` may carry a synchronous `commit(sql)` that the runner executes in the same `transactionSync` as the row's status write, so a stage's last write and its `done` land or roll back together
- the handler honours the chunk ceilings itself (`jobsMaxChunkIterations` / `jobsMaxRowsPerChunk` reach it through the context); the runner only holds the per-pass job count
- **every job implementation must be idempotent.** The DO can reset immediately after the work succeeded and before the row is finalized, and the row is then re-claimed once its lease expires
- the runner wraps each job in its own `try / catch`: one failing job neither aborts the rest of the pass nor escapes `alarm()`. A failure advances `attempt` and pushes `next_run_at` out by backoff; past the limit the row becomes `poison` with a `terminal_reason` for operator escalation
- **when a row has a roll-back stage, the limit does not terminate it directly**: it writes the `terminal_reason` while the row is still runnable (terminal mode), the job stops making forward progress and runs the roll-back, and only a roll-back that itself ends without completing makes the row `poison`. Whether a stage exists is decided per row, not per kind — the selector is `TerminalStageSelector(row, sql)`, set once per DO class, and it reads the row's state through `sql` when the answer depends on it
- `done` rows are pruned; `poison` rows are never pruned, and they count against the DO's 10 GB cap until an operator acts

### Outbox relay

The relay runs inside each DO's `alarm()`, ahead of the job pass — it has no entry point of its own. One pass is three phases, with **only** the publish outside a transaction: claim rows in a transaction, `send()` each to the Queue, finalize in a second one.

Key points:

- **the gap between phases 2 and 3 is where at-least-once comes from.** A DO reset there leaves the row to be re-claimed once its lease expires and published again
- **phases 2 and 3 therefore fail differently and are caught separately.** `quarantined` is defined for a row the relay could not publish; once `send()` has returned, the message is on the Queue and a failed phase 3 is not a publish failure. A phase 3 that throws writes nothing at all — the row stays claimed and its lease expiry re-claims it
- publishing is row by row; `sendBatch` is all-or-nothing and would advance `attempt` on every row claimed in that wake-up, which makes the per-row failure isolation unreachable
- a row that cannot be published has its `attempt` advanced and is pushed out by backoff; past the limit it becomes `quarantined` with a `terminal_reason`. Quarantined rows are never pruned — the operator entries (`list-quarantined-events` / `requeue-quarantined-event` / `delete-quarantined-event`) are how they leave, and `poison` job rows have the same three (`list-poisoned-jobs` / `requeue-poisoned-job` / `delete-poisoned-job`)
- **the allow-list for logs is `event.id` and `type`.** The queue message is never logged as a whole — it carries `owner_token`, which is a reusable secret

### Queue consumer

The consumers are hosted by the **request Worker's** `queue()` handler (`apps/web/app/worker/cloudflare/queueHandlers.ts`), not by a Worker of their own. Delivery is **at-least-once with no ordering guarantee**; write every consumer on that premise.

- **At-least-once (the same event arrives two or more times)** — the DO can reset after the relay published a row and before it finalized, so the same message is published again. Every consumer must be idempotent, **keyed on `event.id`**, and **where it keeps that key is declared per consumer** — there is no shared processed-events store. The mail consumer keeps no key at all: the emitting DO derives a `providerIdempotencyKey` deterministically from `event.id` and hands it back in the send-materials response, and the consumer passes it straight through to the provider without deriving anything itself
- **No ordering** — jobs in different DOs share neither a clock nor a queue, and failures are pushed out by backoff, so `foo.archived` arriving before `foo.created` is routine. Never depend on the relative order of two units of asynchronous work: read the aggregate's current state before deciding, or make the event self-contained
- **The consumer holds no business judgement.** Resolving the recipient, confirming a token is alive, judging supersession and deriving the idempotency key all happen in the emitting DO, behind one RPC. Delivery material that must never be persisted crosses the boundary only as that RPC's response
- **A failure is caught and turned into a queue retry**, never into an unhandled rejection out of `queue()`. Past `max_retries` the message goes to the DLQ; failures on the far side of the queue are not the emitting DO's concern, and no ack is written back to it. A message this build cannot route is retried too, so it reaches the DLQ rather than being discarded against an at-least-once contract
- **The queue is a transport boundary**, so a routing key from a message body is shape-checked before a stub exists — `idFromName` would otherwise open (and initialise) a Durable Object under whatever name it was given
- **The DLQ handler re-drives each message once, then acks.** `handleDlqBatch` runs the same `deliverOnce` the consumer uses and acks whatever the outcome (`sent` / `nothing-to-send` / `unserved` / `failed`), logging one `dlq` line with `eventId`, `type` and the outcome. There is no second re-drive and no manual one; nothing is forwarded — DLQ messages never go to an external monitoring or log-aggregation sink

## Error Design

Representative classes, one per layer role — **not the roster**. The roster is the ban list of `lint/no-instanceof-error.grit`, kept in sync by `lint/banList.test.ts` so there is one place to look and no second ledger to drift. That sync covers the class declarations the scan reaches; the forms it cannot reach are listed under KNOWN LIMITS in the `.grit` header.

| Layer | Error type | Location |
|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | `packages/core/src/domain/error.ts` |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `SystemError` | `packages/core/src/application/errors.ts` |
| Presentation | `InputValidationError` | `apps/web/app/presentation/validator.ts` |
| Presentation | `AppServerError` (transport envelope, extends `Error`) | `apps/web/app/presentation/errorResponse.ts` |

Every error class in that table except `AppServerError` extends the abstract base `CodedError<TCode extends string>` in `packages/core/src/lib/error.ts`. The base class owns the `code: TCode` field, a default `retryable: false` getter, the `Symbol.for("@repo/core/CodedError")` identity brand, and two abstract members: `serializedKind` and `toSerialized()`. The latter's base return type is the structural `SerializedErrorBase & { kind: string }`, and each subclass narrows it via override to its own `kind`-tagged variant.

`serializedKind` is what the guards match on. Identity is tested structurally, never with `instanceof` — which is false across the SSR / RSC module-graph split and is rejected by `lint/no-instanceof-error.grit`.

- **Declaring it.** The base declares `abstract readonly serializedKind: ReturnType<this["toSerialized"]>["kind"]`, so a value disagreeing with the `kind` its own override emits fails to compile (TS2416) — **but only where that override narrows its return type down to its own `kind` literal**. Leave the return type off, or annotate it in the base's own shape (`{ kind: string; … }`), and the binding degrades to `string` and the drift compiles.
- **What actually catches drift.** A runtime check per class, `serializedKind === toSerialized().kind`, scanned in `packages/core/src/application/__tests__/errors.test.ts`, `packages/core/src/domain/__tests__/error.test.ts` and `apps/web/app/presentation/__tests__/validator.test.ts`. Add an error class, add it to that scan. Writing `readonly serializedKind: SerializedConflictError["kind"] = "conflict"` on the subclass changes neither, and documents intent.
- **Checking it.** `isCodedError(error)` for the brand plus the shape the contract needs; `hasSerializedKind(error, kind)` for brand + discriminator, which is the one line every per-kind guard is. Pass that `kind` as `Serialized*Error["kind"]` rather than a bare literal — a typo would otherwise compile into a guard that is always `false`. The application layer's `kindGuard` factory enforces it by construction.
- **What a guard returns.** The structural `Omit<CodedError, "toSerialized"> & { serializedKind; toSerialized() }`, never a concrete class. `Omit` rather than an intersection, which would keep both method signatures and leave `toSerialized()` at the base's wide return type.

`code` is a plain string. The per-class enums are deliberately collapsed (the domain enum plus the `SerializedErrorKind` assembled in presentation cover the classification we need). `SystemErrorCode` is kept because it is used for the runtime `retryable` decision.

`BusinessRuleError<TCode extends string = never>` defaults to `never`. Allowing an unparameterized `BusinessRuleError` would widen `code` to `string` at catch time, so we force the throw side to pass the domain's literal union. On the catch side `isBusinessRuleError(...)` narrows to the contract carrying `kind: "business"`, not to `BusinessRuleError` — read `code` off it as a `string`.

Each error class declares its own `Serialized*Error` variant in the same file (`SerializedBusinessError` in domain, `SerializedNotFoundError` etc. in application) and returns that variant from `toSerialized()`. The presentation layer's `errorResponse.ts` gathers all variants and assembles the `SerializedError` discriminated union. Adding a new error type does not require touching presentation's `serializeError` (it just calls `toSerialized()` structurally). In the presentation layer only the `SerializedError` union and `SerializedErrorKind` need to be appended; outside it the new class still has to enter the ban list and the per-class scan named above.
