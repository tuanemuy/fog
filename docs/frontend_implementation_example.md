# Frontend Implementation Example

Implementation example for TanStack Start with React Server Components enabled, as the app under `apps/web/` uses it.

The `todo` domain that appears in some snippets is an illustration and is not part of this repository — read `apps/web/app/{components,routes}/todo/…` as a pattern, not as files to open. Every other path named below exists; the timeline (`apps/web/app/components/timeline/`, route `apps/web/app/routes/_app/index.tsx`) is the reference implementation of the whole pattern.

Basic design principles:

- **Choose RSC with an awareness of its "owner".** An RSC is nothing more than a React Flight payload returned from `createServerFn`. Decide first where you call it from = who holds that payload.
- **Keep data fetching, authorization, and usecase invocation entirely inside server components.** Treat the loader as "a thin proxy for pulling a server component in as an RSC payload".
- **`throw` errors.** There is no need to convert them to status codes and return them via `data()`. Throwing `redirect({ to })` lets the router pick it up, and any other exception falls back to the route's `errorComponent`. Absence that is a screen state (a deleted document) is rendered by the server component itself, not thrown.
- **Carve out only the parts that need client state with `"use client"`.** Make only the parts that hold forms or interactions into client components.
- **When calling a server function from the client, wrap it with `useServerFn(fn)` and read what it resolves to through `readServerFnResult`.** The first makes `throw redirect({ to })` inside the usecase navigate automatically; the second turns a response of an unexpected shape into a system error instead of a phantom success.
- **The primitives are React 19's own** — `useActionState` for forms, `useTransition` + `useOptimistic` for inline actions, plain `<form>` elements, `router.invalidate()` to reconcile. No query cache, no form library, no toast library: none of these is a dependency of `apps/web`.

## RSC owner patterns

There are three ways an RSC is handled here, distinguished by **who holds and invalidates the Flight payload**, plus the client-owned list for membership changes.

### 1. Held by the route loader (the default)

A fragment tied 1:1 to the URL. The router cache owns it and refetches it via `router.invalidate()`.

```tsx
// illustration — the awaited form
const loadTodoListRouteData = createServerFn({ method: "GET" }).handler(
  async () => {
    const { TodoList } = await import("@/components/todo/TodoList");
    const Rendered = await renderServerComponent(<TodoList />);
    return { TodoList: Rendered };
  },
);

export const Route = createFileRoute("/todo/")({
  // Cache the resolved RSC in prod so a revisit reuses it; keep `0` in DEV for HMR.
  // Freshness after a mutation is driven by an explicit `useRouter().invalidate()`,
  // not by re-running the loader on every navigation.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  loader: () => loadTodoListRouteData(),
  component: HomePage,
});
```

Since the route file also enters the client graph, do not statically import server-only DI or server components. Confine them to the `createServerFn` handler side, and have the loader merely call that bridge.

**When to choose**: fragments uniquely determined by URL parameters, such as list and detail pages. In this app every `_app/*` route is one.

#### Streaming variant: defer the payload and show a skeleton

The awaited form blocks navigation until the data is fully resolved. To make the shell appear instantly and stream the fragment in, the bridge **returns the unresolved promise** and a client-side `<Suspense>` boundary renders a skeleton until the React Flight payload arrives. This is the form every route under `apps/web/app/routes/_app/` takes. The timeline route, verbatim:

```tsx
// apps/web/app/routes/_app/index.tsx
const renderTimeline = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(timelineSearchSchema))
  .handler(async ({ data }) => {
    const { TimelineFeed } = await import("@/components/timeline/TimelineFeed");
    return { Timeline: renderServerComponent(<TimelineFeed search={data} />) };
  });

export const Route = createFileRoute("/_app/")({
  // Mandatory for the streaming variant: a re-run loader hands out a fresh
  // promise and would re-suspend the boundary on every revisit.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  validateSearch: (search) => timelineSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const { Timeline } = await renderTimeline({ data: deps });
    return { Timeline }; // still a Promise<ReactNode>
  },
  head: ({ match }) =>
    routeHead(match, { title: "タイムライン — fog", path: "/" }),
  component: TimelinePage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function TimelinePage() {
  const { Timeline } = Route.useLoaderData();
  return (
    <Suspense fallback={<TimelineSkeleton />}>
      <Deferred promise={Timeline} />
    </Suspense>
  );
}
```

Two helpers carry the pattern:

- `streamingRouteOptions` (`apps/web/app/presentation/streamingRoute.ts`) is spread into every streaming route. It sets `pendingComponent: () => null`, so the fragment skeleton is the only fallback, and `ssr: !import.meta.env.DEV`: under `vite dev` an SSR response carrying an RSC payload never emits the stream end, so the streamed leaf stays unhydrated; the production build (`pnpm build && pnpm preview`) streams and hydrates correctly. Limit: browser checks under `pnpm dev` therefore do not cover the SSR streaming path — verify that on the preview build.
- `Deferred` (`apps/web/app/components/ui/Deferred/index.tsx`) resolves the promise on the client with `use(useDeferredValue(promise))`. The `useDeferredValue` is what keeps the already-resolved content on screen when `router.invalidate()` hands out a *replacement* promise after a mutation: router state arrives through an external store and cannot ride a transition, so without it the boundary would drop back to its fallback and an optimistic entry would flash away before the refetched list replaced it.

Skeletons are shaped to the real DOM of the fragment they stand in for, so the swap happens without layout shift: `TimelineSkeleton`, `TopicsSkeleton`, `TopicDetailSkeleton`, `DocumentSkeleton`, `SearchSkeleton`, `TrashSkeleton`, `MemoHistorySkeleton`, `SettingsSkeleton`, each next to its feed under `apps/web/app/components/<area>/`, all built from the generic `apps/web/app/components/ui/Skeleton`. Each carries one `role="status"` announcement; the bars are `aria-hidden` and respect `prefers-reduced-motion`.

**Route-level pending is a separate mechanism**, wired in `apps/web/app/router.tsx` as `defaultPendingComponent: RoutePendingFallback` with `defaultPendingMs: 200` / `defaultPendingMinMs: 300`. It shows for any route whose loader stays unresolved past the threshold. A streaming route is not automatically exempt: on client navigation its loader still awaits the `/_serverFn/…` round trip that hands over the unresolved promise, and if that hop is slower than `defaultPendingMs` the route-level fallback would show first and the fragment skeleton after. `streamingRouteOptions`' `pendingComponent: () => null` is what prevents the double fallback.

### 2. Call directly from an event handler

Load more data triggered by a user action and merge it into client state. The timeline's infinite scroll is the instance: `TimelineBoard` calls `loadTimelinePageFn` (a GET server function returning a page of view objects, not an RSC) from a transition and merges the result into the list it owns.

```tsx
// apps/web/app/components/timeline/TimelineBoard/index.tsx (excerpt)
const fetchPage = useServerFn(loadTimelinePageFn);
const [loadingOlder, startOlder] = useTransition();

const loadMore = (direction: Direction) => {
  startOlder(async () => {
    try {
      const result = readServerFnResult(
        await fetchPage({ data: { cursor, direction, limit, keyword } }),
        isTimelinePageResult,
        "loadTimelinePageFn",
      );
      setLoaded((current) => mergeTimeline(current, result.items));
      setCursors((current) => ({ ...current, [direction]: result.nextCursor }));
    } catch (failure) {
      setLoadError(displayError(failure));
    }
  });
};
```

**When to choose**: when you don't want it included in the initial load and want to fetch it incrementally on user action.

### 3. Composite Component (embedding client slots)

Not adopted. Every screen is complete with a streamed leaf + ordinary `"use client"` islands. `createCompositeComponent` / `CompositeComponent` from `@tanstack/react-start/rsc` remain available for the case where client interactivity has to be injected into server-rendered markup through `children`, a render prop or a component prop; when you find yourself peeking into a server slot with `Children.map` / `cloneElement`, that is the case.

### Selection flow

| Condition | What to choose |
|---|---|
| Tied 1:1 to the URL | **loader** (streaming variant) |
| Don't want it in the initial load, triggered by user action | **Direct call from an event handler** |
| Want to mix a client UI into server markup | **Composite Component** (not adopted) |
| Want immediate add/remove of list elements | **Client-owned** (below) |

**Bad pattern**: "dual ownership" where the same fragment is fetched by two owners and only one is invalidated.

### Held by the client (optimistic list updates)

A loader-owned RSC list can reflect within-element state immediately via an item-local `useOptimistic`, but **operations that change membership, such as add/remove, are changes to parent state**, so an item-local `useOptimistic` cannot reach them. The leaf hands the list to a `"use client"` island seeded by the server value, and the island owns the entire array with `useOptimistic(base, reducer)`.

**Who calls the server function is determined by "the kind of operation"**:

- In-item operations (inline edit) have the leaf call the server function itself. Since membership doesn't change and the leaf survives, the item-local `useOptimistic` and error display can also live in the leaf (`MemoEntry` and `editMemoFn`).
- Operations that change membership (add / remove) have the owner (the island) call the server function. In particular, **delete must be called by the owner**: with optimistic deletion the leaf unmounts before the request settles, so the error UI placed in the leaf would be discarded. Add is dispatched from the form's action (the composer lives outside the list and survives the round trip).

Every operation calls `router.invalidate()` once it settles, and the optimistic list is re-based onto the refetched latest value (it reverts automatically on failure). The reference implementation is `apps/web/app/components/timeline/TimelineBoard`; the worked example below is its shape.

**When to choose**: when you want to reflect additions/removals to a list within the page immediately. Keeping it loader-owned forces add/remove to always wait on a server round trip, making it feel sluggish.

## Canonical form of the server-only entry point

Usecase invocation on the server goes **through the helpers in `apps/web/app/presentation/serverAction.ts`**. Calling `getContainer()` directly does technically work, but the helpers are the standard.

### The 2 helpers provided

| helper | Purpose |
|---|---|
| `serverData(loadModule, run)` | **Reads** from server components |
| `loadServerDeps(loadModule)` | Loads the DI + usecase module in parallel inside a server function handler |

Both run `getContainer()` and the **dynamic import** of the usecase module in parallel (see the JSDoc in `serverAction.ts` for why the import must stay dynamic).

### Declare the server function itself **inline** at the call site

A server function (mutation / GET loader bridge) must **always have the chain from `createServerFn(...)` through `.handler(...)` written directly at the call site**. Pre-applying common middleware in a separate module and exporting it is **NG**.

```ts
// ✅ correct — complete the chain at the call site
// apps/web/app/components/timeline/actions.ts
export const postMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(postMemoSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/postMemo"),
    );
    return module.postMemo({
      container,
      input: { userId, body: data.body, actor: await userActorOf(userId) },
    });
  });

// ❌ NG — importing a pre-built builder from a separate module
// breaks the build because TanStack Start's RSC plugin can't trace the chain root.
import { defineServerFn } from "@/presentation/serverFn";
export const postMemoFn = defineServerFn
  .inputValidator(validateInput(postMemoSchema))
  .handler(/* ... */);
```

TanStack Start's RSC plugin separates the handler body into the RSC environment on the premise that **a literal `createServerFn(...)` call exists within the same module**. If you start the chain through a re-export, static analysis fails and the build falls over with `Errored while resolving ... Got Plugin driver is already dropped`. A bit of duplication (writing `.middleware([...])` every time) is the price. `noStoreMiddleware` (`apps/web/app/presentation/noStoreMiddleware.ts`) stamps `Cache-Control: no-store` and rides along on every mutation and every authenticated read.

### Division of transport-validation responsibility (serverData vs `inputValidator`)

The fact that `serverData` **does not take a schema** is a deliberate design choice: it declares in the type signature "the precondition that the caller has already passed the transport boundary". The usage split:

| Input source | Validation point | wrapper |
|---|---|---|
| URL search params | route's `validateSearch: schema.parse` | `serverData` (receives the value trusting the type) |
| Forwarding from a parent server fn | parent fn's `inputValidator(schema)` | `serverData` (receives the value trusting the type) |
| Direct POST from the client | the server function's `inputValidator(validateInput(schema))` | `loadServerDeps` inside the handler |

> **Convention**: `serverData` is **for internal calls only**. Any place that handles external input (URL / form / fetch) must **always finish transport validation with either `validateSearch` or `inputValidator` before** passing arguments to a loader wrapped with `serverData`. Do not run Zod again right before the usecase (the VO factory re-validates the same constraints, so it would be a duplicate and would diverge from CLAUDE.md's "validate at the boundaries").

Example: `apps/web/app/routes/_app/index.tsx` normalizes the URL with `validateSearch: (search) => timelineSearchSchema.parse(search)` (a schema whose every entry falls back to "absent", so it never throws), then `renderTimeline` re-validates the transport with `inputValidator(validateInput(timelineSearchSchema))` → passes a typed value to the server component `TimelineFeed`, and `loadPage` / `loadDay` / `loadAround` (wrapped with `serverData` in `apps/web/app/components/timeline/TimelineFeed/index.tsx`) **merely trust** that type.

### Exception where calling `getContainer()` directly is allowed

A helper function that **just hits ports in a few lines**, like the session check, and needs no usecase module may call `getContainer()` directly without going through a wrapper (see "Shared server logic" below). Always place `import "@tanstack/react-start/server-only";` at the top of the file.

## Server component (with data fetching)

The server component is an `async` function that calls loaders wrapped with `serverData`. The document page:

```tsx
// apps/web/app/components/documents/DocumentFeed/index.tsx (excerpt)
const loadDocument = serverData(
  () => import("@repo/core/application/knowledge/getDocument"),
  async ({ container }, { getDocument }, userId: string, documentId: string) =>
    getDocument({ container, input: { userId, documentId } }),
);

/**
 * The streamed leaf of `/documents/:id` (P-08). Absence and the trash are
 * a screen state, not an error page.
 */
export async function DocumentFeed({ documentId }: { documentId: string }) {
  let data: Awaited<ReturnType<typeof loadPage>>;
  try {
    data = await guardStreamedRender(async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      return loadPage(userId, documentId);
    });
  } catch (error) {
    if (extractSerializedError(error).kind === "notFound") {
      return <KnowledgeNotFound subject="ドキュメント" />;
    }
    throw error;
  }
  const { document, sources, topic } = data;
  return <article className="fog-document">{/* … */}</article>;
}
```

### Points

- Because we `await` inside the server component, there is no need to assemble the data in the loader.
- `guardStreamedRender` (`apps/web/app/presentation/errorResponseMiddleware.ts`) wraps the read of every streamed leaf. The HTTP status is already committed by the time the leaf renders, so what it does is classify the failure the way the middleware would — for redaction and for the `system` / `unknown` logging branch — and rethrow. What reaches the client through the RSC error frame is `kind: "unknown"` unless the `serialized` payload survives that boundary; both fail towards less information.
- A `notFound` from the usecase is **rendered**, not thrown: `KnowledgeNotFound` (`apps/web/app/components/knowledge/KnowledgeNotFound`) is the 「見つからない」 state of P-07 / P-08 / P-09 / P-10 with the way back to the topic list. `notFoundComponent` in `apps/web/app/routes/__root.tsx` is for URLs that match no route.
- Consolidate the DI / module loading for usecase invocation on the `serverData` wrapper. Calling `getContainer()` directly requires writing `import "@tanstack/react-start/server-only";` every time, and the moment someone adds a single static import line, the server graph risks leaking into the client; the wrapper's dynamic import structurally blocks this.
- The leaf hands its data to the client island and keys the island on the URL (`TimelineFeed` → `<TimelineBoard key={…} initial={…} search={…} />`), so a `router.invalidate()` for the same URL keeps the island — with its scrolled-in pages — and a URL change remounts it.

## Route definition (a thin proxy that pulls in an RSC)

The route's only responsibility is "pass URL parameters to the server component and send the rendered result to the client as an RSC payload". The streaming route above is the canonical shape; the document detail route (`apps/web/app/routes/_app/documents_.$documentId.tsx`) is the same with `params.documentId` in place of `search`.

### Points

- The loader merely calls the server function bridge. Confine `renderServerComponent(<RSC />)` and server-only imports to the bridge's handler side.
- **Place the shared shell in the parent route's `component`. Do not include the shell in the arguments to the leaf's `renderServerComponent(...)`.** If you do, the shell gets swapped out along with the entire RSC tree and remounted on every transition, and client state such as navigation is lost and flickers. Here the pathless layout `apps/web/app/routes/_app.tsx` renders `AppShell` (`apps/web/app/components/layout/AppShell`) around an `<Outlet />`; every protected screen is a child of it, and only the leaf goes into the RSC payload. `login.tsx` / `signup.tsx` / `password-reset.tsx` sit outside the layout.
- `_app.tsx`'s `beforeLoad` is the navigation aid: it reads `readAuthStateFn` (`apps/web/app/presentation/authState.ts`) and bounces an unauthenticated visitor to `/login` with a same-origin `?redirect=` (`toSafeRedirect`). The guard proper is `requireUserId()` in every server execution point — `beforeLoad` only saves a round trip.
- `head` goes through `routeHead` (`apps/web/app/presentation/head.ts`) so every route carries a title and canonical path.
- Since `staleTime` remains in effect even after navigation, the cache can be reused when you return to the same URL. When you want to force a refetch, use `useRouter().invalidate()` on the client.
- Input validation uses `.inputValidator(...)`. **Do not use the old API `.validator(...)`.**

## Shared server logic (authentication helper)

The session check used by every server component and server function is `apps/web/app/presentation/currentUser.ts`. It is port access with no usecase module, so it is the escape hatch that calls `getContainer()` directly.

```typescript
// apps/web/app/presentation/currentUser.ts
import "@tanstack/react-start/server-only";

export async function getCurrentUserId(): Promise<string | null> {
  const token = readSessionToken();
  if (token === null) return null;
  const container = await getContainer();
  const verified = await container.sessionCodec.verify(token, container.clock.now());
  if (verified === null) return null;
  const account = await readAccountStateOrNull(container, verified.userId);
  if (account === null || account.status !== "active") return null;
  if (account.sessionEpoch > verified.sessionEpoch) return null;
  return verified.userId;
}

export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (userId !== null) return userId;
  const url = getRequestUrl();
  const target = toSafeRedirect(`${url.pathname}${url.search}`);
  throw redirect({
    to: "/login",
    search: target === undefined || target === "/" ? {} : { redirect: target },
  });
}
```

- `getCurrentUserId` verifies the cookie's signature and expiry, then reads the account's current `sessionEpoch` from the user's own Durable Object — on every request, never cached — and treats a generation the object has moved past as no session. Every rejection is the same `null`; nothing about why reaches the caller. A token naming an object that was never initialised (`SystemError(NotInitialized)`) is folded here, and only here, because it is a stale or forged credential, not a broken server.
- `requireUserId` bounces to `/login` carrying the current path (S-AC-03). The carried value passes `redirectPathSchema` (`apps/web/app/presentation/redirectSearch.ts`): same-origin, no `//`, no backslash, no `/_` framework path, no control characters — the same check the login route applies on the way back.
- Just calling `await requireUserId()` at the top of a server function handler or inside `guardStreamedRender` completes the authentication check. There is no `createMiddleware` for it; a plain helper pairs better with RSC. There is no `cache()` around it either: the epoch read is deliberately per call.

The `import "@tanstack/react-start/server-only";` at the top of the file is a mandatory guard when taking the escape hatch.

## Server Function (mutation)

Consolidate state-changing operations into `createServerFn({ method: "POST" })`. For reads, use `createServerFn({ method: "GET" })`, expressing whether there are side effects via the method. For both, always prepend `.middleware([errorResponseMiddleware, noStoreMiddleware])`, and have the first middleware catch throws from **both** `inputValidator` and the handler and convert them into the `AppServerError` envelope and an HTTP status. The client wraps it with `useServerFn(fn)`, reads the resolved value through `readServerFnResult`, and passes the call to React 19's **`useActionState` / `useTransition` / `useOptimistic`**. A generic hook (a `useServerAction`-style wrapper) is intentionally not provided.

### Division of input-validation responsibility

Input validation happens in **only 2 places**. The usecase is not involved.

| Layer | Responsibility |
|---|---|
| Transport boundary (`inputValidator`) | shape / DoS check. Only whether the JSON matches the expected signature |
| Domain VO factory (`MemoBody.create`, etc.) | The final gate for business invariants |

The usecase **trusts the static type of the input and focuses on applying domain logic**. When the VO factory throws a `BusinessRuleError`, it reaches the client as-is in the envelope (`{ kind: "business" }`).

Because `createServerFn`'s `inputValidator` runs on both client and server, the schema statically imported from it **must not pull in `@repo/core/domain/*` or `@repo/core/application/*` at all**. Keep the schema presentation-independent in `apps/web/app/components/<area>/schema.ts`; the same file carries the **result guards** (`isPostMemoResult` etc.) the client reads responses through.

```typescript
// apps/web/app/components/timeline/schema.ts (excerpt)
// Transport bounds only; the value objects hold the business rules.
export const postMemoSchema = z.object({
  body: z.string().max(100_000),
});

/** What `postMemoFn` resolves to, checked at the client boundary. */
export function isPostMemoResult(value: unknown): value is PostMemoResult {
  return (
    isRecord(value) && isRecord(value.memo) && isNonEmptyString(value.memo.id)
  );
}
```

`validateInput` (`apps/web/app/presentation/validator.ts`) turns a Zod failure into `InputValidationError` — the presentation layer's `kind: "validation"` variant with `fieldErrors` — thrown as an `AppServerError` so the same middleware serializes it.

### Reading what a server function resolved to

`errorResponseMiddleware` turns every failure it sees into a rejection, but a response that never reached it — a Worker that died before the handler ran, a platform 500 rendered as JSON, a proxy answering in the server function's place — **resolves** on the client with whatever body the transport parsed. A caller that went on to `router.invalidate()`, clear the form or navigate would be acting on a write that never happened. So every call site reads the resolved value through `readServerFnResult(value, guard, name)` (`apps/web/app/presentation/serverFnResult.ts`) and treats a shape it does not recognise as a system error (`UNEXPECTED_SERVER_FN_RESULT`, retryable): the draft stays, the message shows, the user retries.

```tsx
readServerFnResult(await post({ data: { body } }), isPostMemoResult, "postMemoFn");
```

### Form submission uses `useActionState`

`<form action={formAction}>` + `useActionState` is the canonical React 19 approach. The timeline composer, which is also the list owner's "add":

```tsx
// apps/web/app/components/timeline/TimelineBoard/index.tsx (excerpt)
const [optimistic, dispatch] = useOptimistic<DisplayMemo[], ListAction>(
  base,
  (current, action) =>
    action.kind === "add"
      ? [action.memo, ...current]
      : current.filter((memo) => memo.id !== action.id),
);

// One post per submit event. Two submits dispatched in the same frame
// (`requestSubmit()` twice, Enter and a click) both arrive before the
// pending state disables the controls; the second one is stopped here,
// before React queues its action.
const inFlight = useRef(false);
const guardSubmit = (event: FormEvent<HTMLFormElement>) => {
  if (inFlight.current) event.preventDefault();
};

const [state, action, pending] = useActionState<ComposerState, FormData>(
  async (previous, formData) => {
    const body = String(formData.get("body") ?? "");
    if (body.trim().length === 0) return previous;
    inFlight.current = true;
    const now = new Date();
    dispatch({ kind: "add", memo: { id: `pending-${now.getTime()}`, body, postedAt: now, /* … */ pending: true } });
    try {
      readServerFnResult(await post({ data: { body } }), isPostMemoResult, "postMemoFn");
      setDraft("");
      if (plainList) await router.invalidate();
      else await goto({});
      return { error: null };
    } catch (failure) {
      // The optimistic entry reverts with the transition; the draft stays.
      return { error: displayError(failure) };
    } finally {
      inFlight.current = false;
    }
  },
  { error: null },
);

<form action={action} onSubmit={guardSubmit}>…</form>
```

Fold the display message into the state (`displayError` turns any thrown value into the user-facing text); where a form has more than one field, branch on `extractSerializedError(failure)` — `kind` and `code` — and assign the message to the field it concerns (`AuthForm` maps `EMAIL_ALREADY_REGISTERED` to the email field and `PASSWORD_TOO_WEAK` to the password field).

### Inline actions use `useTransition` + `useOptimistic`

For **immediate actions outside a form**, such as a delete button in a list, take a transition with `useTransition` and dispatch the optimistic update **from within the transition**. The list owner's delete:

```tsx
// apps/web/app/components/timeline/TimelineBoard/index.tsx (excerpt)
const [deleting, startDelete] = useTransition();

const runDelete = (memo: DisplayMemo) => {
  setDeleteFailure(null);
  startDelete(async () => {
    dispatch({ kind: "remove", id: memo.id });
    try {
      readServerFnResult(
        await softDelete({ data: { memoId: memo.id } }),
        isSoftDeleteMemoResult,
        "softDeleteMemoFn",
      );
      // Keep it out of the list across the optimistic revert and until
      // the refetched window no longer carries it.
      setRemoved((current) => new Set(current).add(memo.id));
      setDeleteTarget(null);
      await router.invalidate();
    } catch (failure) {
      setDeleteTarget(null);
      setDeleteFailure({ memo, message: displayError(failure) });
    }
  });
};
```

The leaf (`MemoEntry`) only asks for the delete through a callback and owns nothing about it — the failure message is rendered by the board next to the row that stayed, because the leaf would have been unmounted by the optimistic removal. An item-owned change (inline edit, `editMemoFn` with the OCC `expectedVersion`) stays in the leaf with its own `useOptimistic` and error text, and reports the saved memo back to the owner (`onSaved`) so the owner's copy of the list is current before `router.invalidate()` re-bases it.

### Failures such as Conflict

Failures such as `ConflictError` also ride the envelope and propagate to the client. `displayError` maps every `kind` to its text; where a screen needs a kind-specific branch, use `extractSerializedError(e)` in the action / transition `catch` and switch on `error.kind`:

```tsx
try {
  await edit({ data: { memoId, body, expectedVersion } });
} catch (e) {
  const error = extractSerializedError(e);
  if (error.kind === "conflict") setMessage("他の操作と競合しました。再読み込みしてください");
  else setMessage(displayError(error));
}
```

### Points

- `useServerFn(fn)` auto-detects `isRedirect` and converts it into a router navigation. This avoids falling through the client's try/catch when the usecase does `throw redirect({ to: "/login" })`.
- A `useActionState` action may be async. State updates both before and after `await` enter the same transition. Passing it to `<form action={formAction}>` lets it progressively enhance even on a client where JS has not yet arrived.
- When you want to update a loader-owned RSC on success, explicitly `await router.invalidate()` inside the action / transition. "When to invalidate" is the caller's responsibility.
- Per-field messages come from branching on `extractSerializedError(e)` (`kind` / `code`, and `fieldErrors` on a `validation` error). Validation is consolidated on the server-side Zod, so it arrives in the same envelope no matter which entry point (server function / route loader / test) calls it; there is no client-side form library and no duplicated schema on the client.
- An item-local `useOptimistic` only works on **state that the item owns**. Membership changes belong to the owner island (`TimelineBoard`, `TrashBoard`, `TopicList`): add optimistically prepends, remove filters, `router.invalidate()` re-bases onto the settled value, and delete is never placed in the leaf.

## Error / Not Found

Define `errorComponent` per route; every `_app/*` route renders the same 「読み込めませんでした」 block with `sanitizeRouteError`. Exceptions thrown inside a server component bubble up here.

The site-wide final fallback is the `errorComponent` / `notFoundComponent` in `apps/web/app/routes/__root.tsx`. The hierarchy is as follows:

```
Exception source (loader / server component / server function)
    ↓ throw
Matched child route .errorComponent  ←  stops here if defined
    ↓ if undefined, bubble up
__root.tsx .errorComponent          ←  final fallback (sanitizeRouteError)
```

`redirect()` is caught by the router itself rather than the errorComponent and routed to navigation. `notFoundComponent` in `__root.tsx` answers URLs that match no route; a missing entity inside a matched route is a screen state rendered by the leaf (`KnowledgeNotFound`), see "Server component" above.

### Propagating server function exceptions in structured form

An exception thrown by `createServerFn`'s `handler` reaches the client, but if it stays a plain `Error`, the `cause` chain and stack trace break during serialization, and branching by `kind` becomes impossible. So, in the presentation layer, we provide

- `AppServerError` — an exception class dedicated to propagation (holds `serialized` as an enumerable own property and survives a JSON round trip)
- `appServerErrorAdapter` (registered with `createStart` in `apps/web/app/start.ts`) — a serialization adapter that preserves the class identity of `AppServerError` across a Seroval roundtrip. **It runs only at boundaries via `createServerFn(...).middleware([errorResponseMiddleware])`**. Via direct `fetch` / an RSC error frame / a custom transport, the adapter does not run, and the client receives a plain Error/object (a remnant) that holds `serialized` as an own property. The adapter is symmetric, so its `fromSerializable` also runs while an **incoming** request body is parsed — a client can post a node tagged `$TSR/t/AppServerError`, which is why that leg validates with `asSerializedError` and fails closed to `kind: "unknown"` instead of trusting the payload
- `serializeError(error)` — folds Business / NotFound / Validation, etc. into a `SerializedError` (`{ kind, code, message, retryable?, fieldErrors? }`)
- `extractSerializedError(error)` — extracts the `SerializedError`. One payload stage plus a fallback:
    - Any value carrying a `serialized` own property goes through `asSerializedError`, which validates every field the union declares and **rebuilds the value from the known keys only**, so an unknown property cannot ride along through `redactForClient`'s spread. A payload that fails falls through to `serializeError`.
    - The adapter-passed and adapter-not-passed paths take that same stage, because **the `Symbol.for("@repo/web/AppServerError")` brand is deliberately not consulted here** — it does not survive the serialization boundary this receives values from, and it is forgeable, so it is neither necessary nor sufficient. Matching the brand is `isAppServerError`'s job, which the serialization adapter binds its `test` to.
    - Not client-only: `errorResponseMiddleware` classifies with it too, which is why the shape of a thrown value must never derive from external input. Translate a value that came off the wire into an error class instead of re-throwing it.
    - **UI code must always go through this function.** `instanceof AppServerError` is false both on the adapter-not-passed path and across the SSR / RSC module-graph split, and breaks silently — `lint/no-instanceof-error.grit` rejects it.
- `readServerFnResult(value, guard, name)` — the counterpart for the **resolved** side (above): a response that bypassed the middleware is not trusted just because it did not reject
- `errorResponseMiddleware` (`apps/web/app/presentation/errorResponseMiddleware.ts`) — wraps the entire server function (both `inputValidator` and the handler) to apply the above and set the HTTP status from `SerializedErrorKind`. TanStack Router's `redirect()` / `notFound()` sentinels are rethrown as-is. **Write `createServerFn(...).middleware([errorResponseMiddleware])` directly at the call site** (pre-applying via a separate module is not allowed because it breaks the RSC plugin's static rewrite)

(`apps/web/app/presentation/errorResponse.ts`).

`displayError` / `sanitizeRouteError` (`apps/web/app/presentation/errorDisplay.ts`) dispatch through a `Record<SerializedErrorKind, handler>`-typed table, so adding a new variant to `SerializedError.kind` produces a compile error. The aim is to guarantee exhaustiveness at the type level.

## Summary: must-haves for the current `@tanstack/react-start`

- Vite: the three-plugin setup of `tanstackStart({ srcDirectory: "app", rsc: { enabled: true } })` + `rsc()` (`@vitejs/plugin-rsc`) + `viteReact()`
- Server function validation: **`.inputValidator(...)`** (`.validator(...)` is the old API)
- RSC high-level API in use: `renderServerComponent`, forwarded unresolved and resolved by `Deferred` under `<Suspense>`; every streaming route spreads `streamingRouteOptions`
- server-only boundary: place `import "@tanstack/react-start/server-only";` at the top of the DI container and server helpers. Do not place it in server function definition files that client components import; enter the server-only side via a dynamic import inside the handler
- Calling a server function from the client: **wrap it with `useServerFn(fn)`** (with automatic redirect handling) and **read the result with `readServerFnResult`**
- Consolidate the server-side entry points that call usecases on the **`serverData` / `loadServerDeps` helpers**. Only port-access helpers such as `currentUser.ts` call `getContainer()` directly (escape hatch)
- Client state: React 19 primitives only (`useActionState` / `useTransition` / `useOptimistic`) with `router.invalidate()` to reconcile. No query cache, no form library, no toast library
- Low-level APIs (`renderToReadableStream` / `createFromReadableStream` / `createFromFetch`) only when a custom transport is needed
